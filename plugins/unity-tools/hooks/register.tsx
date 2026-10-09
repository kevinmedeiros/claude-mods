import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BuildJob, CompileError, Platform, ProjectInfo, TestJob } from '../types'
import {
  ancestors,
  asmdefName,
  csprojHas,
  defaultAssembly,
  defaultEditorPath,
  dirname,
  editorVersion,
  extraTargets,
  failuresText,
  formatErrors,
  guard,
  isUnder,
  join,
  norm,
  parseCompileErrors,
  parseTestResults,
  playbackEngines,
  projectReferences,
  rel,
  testSummary,
  unityLogProblem,
} from './unity'

const PANE = 'unity-tools'
const TOOL = 'mcp__unity-tools__unity_tests'

const project = atom({ plugin: 'unity-tools', key: 'project' } as const, null)
const compile = atom({ plugin: 'unity-tools', key: 'compile' } as const, {})
const tests = atom({ plugin: 'unity-tools', key: 'tests' } as const, {})
const build = atom({ plugin: 'unity-tools', key: 'build' } as const, null)

type Options = {
  projectPath: string
  unityPath: string
  coreDir: string
  compileCheck: boolean
  allowSceneEdits: boolean
  serverBuildPath: string
  buildMethod: string
}

/** O que vale enquanto o módulo está carregado. */
const live = {
  options: undefined as Options | undefined,
  /** Assembly de cada pasta já resolvida. */
  asmByDir: new Map<string, string>(),
  /** Assemblies compilados nesta sessão (as dependências só compilam uma vez). */
  built: new Set<string>(),
  running: new Set<string>(),
}

const run = async ($: EngineInterface, argv: string[], cwd?: string, timeoutMs = 10_000) => {
  try {
    return await $.process.run(argv, { cwd, timeoutMs })
  } catch {
    return undefined
  }
}

// ---------- projeto ----------

const isProject = async ($: EngineInterface, dir: string) => $.fs.exists(join(dir, 'ProjectSettings/ProjectVersion.txt'))

/** Acha o projeto Unity: a pasta configurada, as de cima da sessão ou até dois níveis abaixo. */
const findRoot = async ($: EngineInterface, cwd: string, configured: string): Promise<string | undefined> => {
  if (configured) return (await isProject($, configured)) ? norm(configured) : undefined
  for (const dir of ancestors(cwd)) if (await isProject($, dir)) return dir
  const level = async (dir: string) => {
    try {
      return (await $.fs.list(dir)).filter(e => e.kind === 'dir' && !e.name.startsWith('.')).map(e => join(dir, e.name))
    } catch {
      return []
    }
  }
  for (const child of await level(cwd)) {
    if (await isProject($, child)) return child
    for (const grandchild of (await level(child)).slice(0, 40)) if (await isProject($, grandchild)) return grandchild
  }

  return undefined
}

const detect = async ($: EngineInterface, cwd: string, options: Options): Promise<ProjectInfo | null> => {
  const root = await findRoot($, cwd, options.projectPath)
  if (root === undefined) return null
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const version = editorVersion(await $.fs.read(join(root, 'ProjectSettings/ProjectVersion.txt')))
  const editor = options.unityPath || (version ? defaultEditorPath(version, isWindows) : undefined)
  const hasEditor = editor !== undefined && (await $.fs.exists(editor))
  const dotnet = await run($, ['dotnet', '--version'], root)
  let hasLinuxServer = false
  if (editor && hasEditor) {
    const variations = join(playbackEngines(editor, isWindows), 'LinuxStandaloneSupport/Variations')
    try {
      hasLinuxServer = (await $.fs.list(variations)).some(e => /server/i.test(e.name))
    } catch {
      hasLinuxServer = false
    }
  }

  return { root, version, editor, hasEditor, isWindows, hasDotnet: dotnet?.exitCode === 0, hasLinuxServer }
}

// ---------- compilação ----------

/** O assembly de um script: o .asmdef mais próximo acima dele, ou o padrão do Unity. */
const asmFor = async ($: EngineInterface, root: string, file: string) => {
  let dir = dirname(file)
  const visited: string[] = []
  while (isUnder(root, dir)) {
    const cached = live.asmByDir.get(dir)
    if (cached) return cached
    visited.push(dir)
    const asmdef = (await $.fs.list(dir)).find(e => e.kind === 'file' && e.name.endsWith('.asmdef'))
    if (asmdef) {
      const name = asmdefName(await $.fs.read(join(dir, asmdef.name)))
      if (name) {
        for (const d of visited) live.asmByDir.set(d, name)
        return name
      }
    }
    dir = dirname(dir)
  }

  return defaultAssembly(rel(root, file))
}

/**
 * Compila um assembly com dotnet build a partir do .csproj que o Unity gera,
 * fora do projeto (Temp/claude-check). As dependências compilam antes, uma vez.
 */
const compileAsm = async (
  $: EngineInterface,
  root: string,
  asm: string,
  newFiles: string[],
  depth = 0,
): Promise<CompileError[] | 'no-csproj'> => {
  const csprojPath = join(root, `${asm}.csproj`)
  if (!(await $.fs.exists(csprojPath))) return 'no-csproj'
  const csproj = await $.fs.read(csprojPath)
  if (depth < 6) {
    for (const ref of projectReferences(csproj)) {
      if (!live.built.has(ref)) await compileAsm($, root, ref, [], depth + 1)
    }
  }
  const out = join(root, 'Temp/claude-check')
  const targets = join(out, `extra-${asm}.targets`)
  await $.fs.write(targets, extraTargets(newFiles.filter(f => !csprojHas(csproj, rel(root, f)))))
  const result = await run(
    $,
    [
      'dotnet',
      'build',
      `${asm}.csproj`,
      '-nologo',
      '-v',
      'q',
      '-clp:NoSummary',
      `-p:BaseIntermediateOutputPath=${out}/obj/${asm}/`,
      `-p:IntermediateOutputPath=${out}/obj/${asm}/`,
      `-p:OutputPath=${out}/bin/`,
      '-p:BuildProjectReferences=false',
      `-p:CustomAfterMicrosoftCommonTargets=${targets}`,
    ],
    root,
    180_000,
  )
  live.built.add(asm)

  return result ? parseCompileErrors(`${result.stdout}\n${result.stderr}`, root) : []
}

/** Checa o assembly de um .cs editado; o texto para o Claude, quando há o que dizer. */
const checkFile = async ($: EngineInterface, info: ProjectInfo, file: string): Promise<string | undefined> => {
  const asm = await asmFor($, info.root, file)
  if (live.running.has(`compile:${asm}`)) return undefined
  live.running.add(`compile:${asm}`)
  try {
    const before = (await read($, compile))[asm]
    const errors = await compileAsm($, info.root, asm, [file])
    if (errors === 'no-csproj') {
      return before === undefined
        ? `unity-tools: não achei ${asm}.csproj. No Unity, use Preferences > External Tools > Regenerate project files ` +
            'para a checagem de compilação funcionar.'
        : undefined
    }
    const at = await $.clock.now()
    await update($, compile, all => ({ ...all, [asm]: { errors, at } }))
    await refreshStatus($)
    if (errors.length > 0) return formatErrors(asm, errors)

    return before && before.errors.length > 0 ? `Compilação Unity (${asm}): ✓ compila de novo.` : undefined
  } finally {
    live.running.delete(`compile:${asm}`)
  }
}

// ---------- testes ----------

const runTests = async ($: EngineInterface, platform: Platform): Promise<TestJob> => {
  const info = await read($, project)
  const startedAt = await $.clock.now()
  const fail = async (problem: string) => {
    const job: TestJob = { platform, status: 'error', startedAt, endedAt: await $.clock.now(), problem }
    await update($, tests, all => ({ ...all, [platform]: job }))
    await refreshStatus($)
    return job
  }
  if (!info) return fail('Nenhum projeto Unity nesta sessão.')
  if (!info.editor || !info.hasEditor) return fail(`Editor do Unity não encontrado (${info.editor ?? 'sem versão'}). Configure unityPath.`)
  if (live.running.has(`tests:${platform}`)) return fail('Esses testes já estão rodando.')

  live.running.add(`tests:${platform}`)
  await update($, tests, all => ({ ...all, [platform]: { platform, status: 'running', startedAt } }))
  await refreshStatus($)
  const dir = join(info.root, 'Temp/claude-tests')
  const xml = join(dir, `${platform}.xml`)
  const log = join(dir, `${platform}.log`)
  try {
    await $.fs.write(join(dir, '.keep'), '')
    const result = await run(
      $,
      [info.editor, '-batchmode', '-projectPath', info.root, '-runTests', '-testPlatform', platform, '-testResults', xml, '-logFile', log],
      info.root,
      600_000,
    )
    const fresh = (await $.fs.exists(xml)) && (await $.fs.stat(xml)).mtimeMs >= startedAt - 1000
    const parsed = fresh ? parseTestResults(await $.fs.read(xml), platform) : undefined
    if (parsed) {
      const job: TestJob = { platform, status: 'done', startedAt, endedAt: await $.clock.now(), result: parsed }
      await update($, tests, all => ({ ...all, [platform]: job }))
      await refreshStatus($)
      return job
    }
    let problem: string | undefined
    if (await $.fs.exists(log)) {
      const size = (await $.fs.stat(log)).size
      if (size < 4_000_000) problem = unityLogProblem(await $.fs.read(log))
    }
    return fail(
      problem ??
        (result === undefined
          ? 'O Unity não terminou em 10 minutos.'
          : `O Unity saiu com código ${result.exitCode} sem resultado de testes. Veja o log em ${log}.`),
    )
  } finally {
    live.running.delete(`tests:${platform}`)
  }
}

const testsText = (job: TestJob) => {
  if (job.status === 'error') return `Testes ${job.platform}: não rodaram. ${job.problem ?? ''}`
  if (!job.result) return `Testes ${job.platform}: rodando…`
  const r = job.result
  const head = `Testes ${testSummary(r)} (${Math.round(r.durationSec)}s)`

  return r.failed > 0 ? `${head}\nFalhas:\n${failuresText(r)}` : head
}

// ---------- build do servidor ----------

const runBuild = async ($: EngineInterface) => {
  const info = await read($, project)
  const options = live.options
  const startedAt = await $.clock.now()
  const set = (job: BuildJob) => update($, build, () => job)
  if (!info || !options) return
  if (!info.editor || !info.hasEditor) {
    await set({ status: 'error', startedAt, lines: [], problem: 'Editor do Unity não encontrado. Configure unityPath.' })
    return
  }
  if (!info.hasLinuxServer) {
    await set({
      status: 'error',
      startedAt,
      lines: [],
      problem:
        `Falta o módulo "Linux Dedicated Server Build Support" no Unity ${info.version ?? ''}. ` +
        'Instale pelo Unity Hub (Installs > ⚙ > Add modules) e rode de novo.',
    })
    return
  }
  if (live.running.has('build')) return
  live.running.add('build')
  const output = join(info.root, options.serverBuildPath)
  const argv = [
    info.editor,
    '-batchmode',
    '-quit',
    '-projectPath',
    info.root,
    '-buildTarget',
    'Linux64',
    '-standaloneBuildSubtarget',
    'Server',
    '-logFile',
    '-',
    ...(options.buildMethod ? ['-executeMethod', options.buildMethod] : ['-buildLinux64Player', output]),
  ]
  const lines: string[] = []
  let lastPush = 0
  try {
    await set({ status: 'running', startedAt, lines: [] })
    let rest = ''
    const child = $.process.spawn({ argv, cwd: info.root })
    for await (const { text } of child) {
      const parts = (rest + text).split(/\r?\n/)
      rest = parts.pop() ?? ''
      for (const line of parts) if (line.trim()) lines.push(line)
      if (lines.length > 400) lines.splice(0, lines.length - 400)
      const now = await $.clock.now()
      if (now - lastPush > 1000) {
        lastPush = now
        await set({ status: 'running', startedAt, lines: lines.slice(-40) })
      }
    }
    const end = await child.result
    const all = lines.join('\n')
    const ok = /Build Finished, Result: Success/i.test(all) || (end.code === 0 && !/Result: Failed/i.test(all))
    await set({
      status: ok ? 'done' : 'error',
      startedAt,
      endedAt: await $.clock.now(),
      lines: lines.slice(-40),
      problem: ok ? undefined : (unityLogProblem(all) ?? `O build falhou (código ${end.code ?? '?'}).`),
    })
    $.ui.toast(ok ? `Build do servidor pronto: ${output}` : 'Build do servidor falhou; veja o painel /unity.', { timeoutMs: 10_000 })
  } catch (error) {
    await set({ status: 'error', startedAt, lines: lines.slice(-40), problem: `Não consegui iniciar o Unity: ${String(error)}` })
  } finally {
    live.running.delete('build')
  }
}

// ---------- status ----------

const refreshStatus = async ($: EngineInterface) => {
  const info = await read($, project)
  if (!info) return $.ui.status(undefined)
  const parts: string[] = []
  const failing = Object.entries(await read($, compile)).filter(([, c]) => c.errors.length > 0)
  if (failing.length > 0) {
    const n = failing.reduce((sum, [, c]) => sum + c.errors.length, 0)
    parts.push(`✗ ${n} erro${n === 1 ? '' : 's'} de compilação (${failing.map(([a]) => a.split('.').pop()).join(', ')})`)
  } else if (Object.keys(await read($, compile)).length > 0) {
    parts.push('✓ compila')
  }
  for (const job of Object.values(await read($, tests))) {
    if (!job) continue
    parts.push(job.status === 'running' ? `${job.platform} rodando…` : job.result ? testSummary(job.result) : `${job.platform} ✗`)
  }
  $.ui.status(parts.length > 0 ? `Unity · ${parts.join(' · ')}` : undefined)
}

const startTests = ($: EngineInterface, platforms: Platform[]) => {
  void (async () => {
    for (const platform of platforms) {
      const job = await runTests($, platform)
      $.ui.toast(testsText(job).split('\n')[0] ?? '', { timeoutMs: 8000 })
    }
  })()
}

const parsePlatforms = (args: string): Platform[] => {
  const a = args.trim().toLowerCase()
  if (a.startsWith('play')) return ['PlayMode']
  if (a.startsWith('edit') || a === '') return ['EditMode']
  return ['EditMode', 'PlayMode']
}

export const register: Register = (on, raw) => {
  const options: Options = {
    projectPath: String(raw.projectPath ?? ''),
    unityPath: String(raw.unityPath ?? ''),
    coreDir: String(raw.coreDir ?? 'Assets/Scripts/Core'),
    compileCheck: raw.compileCheck !== false,
    allowSceneEdits: raw.allowSceneEdits === true,
    serverBuildPath: String(raw.serverBuildPath ?? 'Builds/Server/Server.x86_64'),
    buildMethod: String(raw.buildMethod ?? ''),
  }
  live.options = options

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const info = await detect($, started.cwd, options)
    await update($, project, () => info)
    if (!info) return started
    await $.command.register({ name: 'unity', description: 'Painel do Unity: compilação, testes e build do servidor' })
    await $.command.register({
      name: 'testes',
      description: 'Roda os testes do Unity em batch (editmode, playmode ou tudo)',
      argumentHint: '[editmode|playmode|tudo]',
    })
    await $.command.register({ name: 'build-servidor', description: 'Gera o build Linux do servidor dedicado' })
    await $.tool.register({
      name: 'unity_tests',
      description:
        'Roda os testes do Unity deste projeto em batch (EditMode ou PlayMode) e devolve o resumo com as falhas. ' +
        'Use depois de mudar regras de jogo ou rede para verificar. Leva de 1 a 10 minutos e só funciona com o ' +
        'Unity Editor fechado para este projeto.',
      inputSchema: {
        type: 'object',
        properties: { platform: { type: 'string', enum: ['EditMode', 'PlayMode'] } },
        required: ['platform'],
      },
    })
    await refreshStatus($)

    return started
  })

  // Guardas e checagem de compilação nas ferramentas que escrevem.
  on('tool.call', async ($, e, next) => {
    const info = await read($, project)
    if (!info || (e.tool !== 'Edit' && e.tool !== 'Write' && e.tool !== 'Bash')) return next(e)

    const reason =
      e.tool === 'Bash'
        ? guard({ tool: 'Bash', command: e.command }, { root: info.root, ...options })
        : guard(
            {
              tool: e.tool,
              path: e.file_path,
              newText: e.tool === 'Write' ? e.content : e.new_string,
              exists: e.tool === 'Write' && e.file_path.endsWith('.meta') ? await $.fs.exists(e.file_path) : undefined,
            },
            { root: info.root, ...options },
          )
    if (reason) return { deny: reason }

    const ran = await next(e)
    if (
      e.tool === 'Bash' ||
      ran.deny ||
      ran.isError ||
      !options.compileCheck ||
      !info.hasDotnet ||
      !/\.cs$/i.test(e.file_path) ||
      !isUnder(join(info.root, 'Assets'), e.file_path)
    ) {
      return ran
    }
    const note = await checkFile($, info, e.file_path)
    if (!note || ran.deny !== undefined) return ran

    return { ...ran, context: [...(ran.context ?? []), note] }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { platform?: string }
    const platform: Platform = input.platform === 'PlayMode' ? 'PlayMode' : 'EditMode'

    return { result: testsText(await runTests($, platform)) }
  }).catch(() => ({ result: 'unity-tools: não consegui rodar os testes do Unity.' }))

  on('command.run', { command: 'unity' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Unity' })
    return { text: 'Painel do Unity aberto.' }
  })

  on('command.run', { command: 'testes' }, async ($, e) => {
    const platforms = parsePlatforms(e.args)
    startTests($, platforms)
    await $.ui.open({ id: PANE, title: 'Unity' })
    return { text: `Rodando ${platforms.join(' e ')} em batch; o resultado aparece no painel /unity e na linha de status.` }
  })

  on('command.run', { command: 'build-servidor' }, async $ => {
    void runBuild($)
    await $.ui.open({ id: PANE, title: 'Unity' })
    return { text: 'Build do servidor iniciado; acompanhe no painel /unity.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const info = await read($, project)
    if (!info) return <Text dimColor>Nenhum projeto Unity encontrado a partir da pasta desta sessão.</Text>
    const compiled = Object.entries(await read($, compile))
    const jobs = await read($, tests)
    const job = await read($, build)
    const now = await $.clock.now()
    const failures = Object.values(jobs).flatMap(j => (j?.result && j.result.failed > 0 ? [j.result] : []))

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text bold>Projeto</Text>
          <Text dimColor>
            {info.root} · Unity {info.version ?? '?'} {info.hasEditor ? '✓' : '✗ editor não encontrado'} · dotnet{' '}
            {info.hasDotnet ? '✓' : '✗ (sem checagem de compilação)'} · servidor Linux {info.hasLinuxServer ? '✓' : '✗'}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Compilação</Text>
          {compiled.length === 0 && <Text dimColor>Ainda não houve edição de .cs nesta sessão.</Text>}
          {compiled.map(([asm, c]) => (
            <Box key={asm} flexDirection="column">
              <Text color={c.errors.length > 0 ? 'error' : 'success'}>
                {c.errors.length > 0 ? '✗' : '✓'} {asm}
                {c.errors.length > 0 ? ` · ${c.errors.length} erro${c.errors.length === 1 ? '' : 's'}` : ''}
              </Text>
              {c.errors.slice(0, 8).map(err => (
                <Text key={`${err.file}:${err.line}:${err.code}`} dimColor>
                  {'  '}
                  {err.file}({err.line}): {err.code} {err.message}
                </Text>
              ))}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold>Testes</Text>
          {(['EditMode', 'PlayMode'] as const).map(p => {
            const j = jobs[p]
            if (!j) return <Text key={p} dimColor>{p}: não rodado nesta sessão</Text>
            if (j.status === 'running') {
              return <Text key={p} color="warning">{p}: rodando há {Math.round((now - j.startedAt) / 1000)}s…</Text>
            }
            if (j.status === 'error') return <Text key={p} color="error">{p}: {j.problem}</Text>
            const r = j.result!
            return (
              <Box key={p} flexDirection="column">
                <Text color={r.failed > 0 ? 'error' : 'success'}>
                  {testSummary(r)} · {Math.round(r.durationSec)}s
                </Text>
                {r.failures.slice(0, 6).map(f => (
                  <Text key={f.name} dimColor>
                    {'  '}✗ {f.name}: {f.message.split('\n')[0]}
                  </Text>
                ))}
              </Box>
            )
          })}
          <Box flexDirection="row" columnGap={2}>
            <Button key="run-edit" label="Rodar EditMode" onPress={() => startTests($, ['EditMode'])} />
            <Button key="run-play" label="Rodar PlayMode" onPress={() => startTests($, ['PlayMode'])} />
            {failures.length > 0 && (
              <Button
                key="send-failures"
                label="Mandar falhas pro Claude"
                variant="primary"
                onPress={() =>
                  void $.prompt.fill({
                    text: `Os testes do Unity falharam. Investigue e corrija:\n${failures.map(r => failuresText(r)).join('\n')}`,
                  })
                }
              />
            )}
          </Box>
        </Box>

        <Box flexDirection="column">
          <Text bold>Build do servidor (Linux, dedicado)</Text>
          {!job && <Text dimColor>Nenhum build nesta sessão. Saída: {options.serverBuildPath}</Text>}
          {job && (
            <Text color={job.status === 'error' ? 'error' : job.status === 'done' ? 'success' : 'warning'}>
              {job.status === 'running'
                ? `Rodando há ${Math.round((now - job.startedAt) / 1000)}s…`
                : job.status === 'done'
                  ? `✓ Pronto em ${Math.round(((job.endedAt ?? now) - job.startedAt) / 1000)}s`
                  : `✗ ${job.problem ?? 'Falhou'}`}
            </Text>
          )}
          {job?.lines.slice(-12).map((line, i) => (
            <Text key={`l${i}`} dimColor wrap="truncate">
              {line}
            </Text>
          ))}
          <Box flexDirection="row" columnGap={2}>
            <Button key="build" label="Gerar build do servidor" onPress={() => void runBuild($)} />
          </Box>
        </Box>
      </Box>
    )
  })
}
