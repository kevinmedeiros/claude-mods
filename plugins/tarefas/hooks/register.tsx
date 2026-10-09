import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Section, Task } from '../types'
import { addTask, completeTask, extractPending, findTask, isImportable, moveTask, parseTasks } from './tasks'

const PANE = 'tarefas'
const PREFIX = 'mcp__tarefas__'

const board = atom({ plugin: 'tarefas', key: 'board' } as const, null)
const notice = atom({ plugin: 'tarefas', key: 'notice' } as const, null)

/** Onde está o TASKS.md desta sessão. */
const where = { root: '', file: '', project: '' }

const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()

const today = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Relê o TASKS.md; `force` relê mesmo sem mudança na data do arquivo. */
const load = async ($: EngineInterface, force = false) => {
  if (!where.file) return
  const exists = await $.fs.exists(where.file)
  const mtimeMs = exists ? (await $.fs.stat(where.file)).mtimeMs : 0
  const held = await read($, board)
  if (!force && held && held.exists === exists && held.mtimeMs === mtimeMs) return
  const tasks = exists ? parseTasks(await $.fs.read(where.file)) : []
  const next: Board = { path: where.file, project: where.project, exists, tasks, mtimeMs }
  await update($, board, () => next)
}

const readText = async ($: EngineInterface) => ((await $.fs.exists(where.file)) ? await $.fs.read(where.file) : undefined)

const save = async ($: EngineInterface, text: string) => {
  await $.fs.write(where.file, text)
  await load($, true)
}

const say = async ($: EngineInterface, text: string) => {
  await update($, notice, () => text)
  $.ui.toast(text, { timeoutMs: 6000 })
}

const add = async ($: EngineInterface, title: string, context?: string, section?: Section, by?: string) => {
  const result = addTask(await readText($), { title, context, section })
  if (!result.added) return result.task ? `Já existe: ${result.task.title}` : 'Título vazio.'
  await save($, result.text)
  const where2 = section && section !== 'Active' ? ` (${section})` : ''
  await say($, `${by ?? 'Nova tarefa'}: ${result.task?.title ?? title}${where2}`)

  return `Tarefa criada: ${result.task?.title ?? title}${where2}`
}

const complete = async ($: EngineInterface, query: string, by?: string) => {
  const text = await readText($)
  if (!text) return 'Ainda não há TASKS.md neste projeto.'
  const result = completeTask(text, query, today(await $.clock.now()))
  if (!result.task) return `Não achei a tarefa "${query}".`
  if (result.text === text) return `Já estava feita: ${result.task.title}`
  await save($, result.text)
  await say($, `${by ?? 'Feita'}: ${result.task.title}`)

  return `Tarefa concluída: ${result.task.title}`
}

const activate = async ($: EngineInterface, query: string) => {
  const text = await readText($)
  if (!text) return
  const result = moveTask(text, query, 'Active')
  if (result.text !== text) await save($, result.text)
}

/** Varre os markdown da raiz e de docs/ atrás de pendências e põe as novas em Someday. */
const importPending = async ($: EngineInterface) => {
  const found: { title: string; context?: string; source: string }[] = []
  for (const dir of [where.root, join(where.root, 'docs')]) {
    let entries: { name: string; kind: string; size: number }[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.kind !== 'file' || !isImportable(e.name) || e.size > 1_000_000) continue
      const file = join(dir, e.name)
      if (norm(file) === norm(where.file)) continue
      const rel = file.slice(where.root.replace(/[\\/]+$/, '').length + 1)
      found.push(...extractPending(await $.fs.read(file), rel))
    }
  }
  let text = await readText($)
  let added = 0
  for (const p of found.slice(0, 60)) {
    const result = addTask(text, { title: p.title, context: [p.context, `de ${p.source}`].filter(Boolean).join(' · '), section: 'Someday' })
    text = result.text
    if (result.added) added++
  }
  if (added > 0 && text) await save($, text)
  const skipped = found.length - added
  const msg =
    found.length === 0
      ? 'Nenhuma pendência encontrada nos markdown da raiz e de docs/.'
      : `Importei ${added} pendência${added === 1 ? '' : 's'} para "Someday"${skipped > 0 ? ` (${skipped} já existiam ou passaram do limite)` : ''}. Use ↑ para ativar.`
  await say($, msg)

  return msg
}

const startPrompt = (t: Task) =>
  `Faça a tarefa "${t.title}" do TASKS.md${t.context ? ` (${t.context})` : ''}. Quando terminar, marque como feita.`

const listText = (b: Board | null) => {
  if (!b?.exists) return 'Ainda não há TASKS.md neste projeto.'
  const open = b.tasks.filter(t => !t.done)
  if (open.length === 0) return 'Nenhuma tarefa aberta.'
  const bySection = (s: Section) => open.filter(t => t.section === s)

  return (['Active', 'Waiting On', 'Someday'] as const)
    .filter(s => bySection(s).length > 0)
    .map(s => `${s}:\n${bySection(s).map(t => `- ${t.title}${t.context ? ` — ${t.context}` : ''}`).join('\n')}`)
    .join('\n\n')
}

export const register: Register = (on, options) => {
  const tasksPath = String(options.tasksPath ?? 'TASKS.md')
  const showBand = options.showBand !== false
  const claudeCanEdit = options.claudeCanEdit !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let root = started.cwd
    try {
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: started.cwd, timeoutMs: 5000 })
      if (r.exitCode === 0 && r.stdout.trim()) root = r.stdout.trim()
    } catch {
      // Sem git: a pasta da sessão é a raiz.
    }
    where.root = root
    where.file = join(root, tasksPath)
    where.project = root.split(/[\\/]/).filter(Boolean).pop() ?? root
    await load($, true)

    for (const spec of [
      { name: 'tarefas', description: 'Lista as tarefas do projeto (TASKS.md); "importar" traz pendências das notas e backlogs', argumentHint: '[importar]' },
      { name: 'tarefa', description: 'Cria uma tarefa no TASKS.md do projeto', argumentHint: '<título> [- contexto]' },
    ]) {
      try {
        await $.command.register(spec)
      } catch {
        // Outro plugin já tem esse comando: o painel e as ferramentas continuam.
      }
    }
    await $.tool.register({
      name: 'task_list',
      description: 'Lista as tarefas abertas do projeto (TASKS.md), por seção. Use para saber o que falta fazer.',
    })
    if (claudeCanEdit) {
      await $.tool.register({
        name: 'task_add',
        description:
          'Cria uma tarefa no TASKS.md do projeto. Use quando encontrar trabalho que fica para depois (uma pendência, ' +
          'um bug visto de passagem, um passo que falta) em vez de só mencionar no texto. Não crie tarefa para o que vai ' +
          'fazer agora.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Curto e acionável, ex.: "Portar a esquiva para o FishNet"' },
            context: { type: 'string', description: 'Opcional: arquivo, motivo ou detalhe' },
            section: { type: 'string', enum: ['Active', 'Waiting On', 'Someday'] },
          },
          required: ['title'],
        },
      })
      await $.tool.register({
        name: 'task_done',
        description: 'Marca uma tarefa do TASKS.md como feita, pelo título (ou parte dele). Use quando terminar o trabalho dela.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      })
    }
    $.clock.every(20_000, () => void load($))

    return started
  })

  // Edições no TASKS.md feitas pelo Claude com Edit/Write: relê na hora.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e.tool === 'Edit' || e.tool === 'Write') && where.file && norm(e.file_path) === norm(where.file)) await load($, true)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: `${PREFIX}task_list` }, async $ => {
    await load($)
    return { result: listText(await read($, board)) }
  }).catch(() => ({ result: 'Não consegui ler o TASKS.md.' }))

  on('tool.call', { tool: `${PREFIX}task_add` }, async ($, e) => {
    const input = e as unknown as { title?: string; context?: string; section?: Section }
    return { result: await add($, String(input.title ?? ''), input.context, input.section, 'Claude criou a tarefa') }
  }).catch(() => ({ result: 'Não consegui gravar o TASKS.md.' }))

  on('tool.call', { tool: `${PREFIX}task_done` }, async ($, e) => {
    const input = e as unknown as { title?: string }
    return { result: await complete($, String(input.title ?? ''), 'Claude concluiu') }
  }).catch(() => ({ result: 'Não consegui gravar o TASKS.md.' }))

  on('command.run', { command: 'tarefa' }, async ($, e) => {
    const raw = e.args.trim()
    if (!raw) return { text: 'Uso: /tarefa <título> [- contexto]' }
    const cut = raw.search(/\s[-–—]\s/)
    return { text: await add($, cut > 0 ? raw.slice(0, cut) : raw, cut > 0 ? raw.slice(cut + 3) : undefined) }
  })

  on('command.run', { command: 'tarefas' }, async ($, e) => {
    if (/^import/i.test(e.args.trim())) return { text: await importPending($) }
    await load($, true)
    await $.ui.open({ id: PANE, title: 'Tarefas' })
    return { text: listText(await read($, board)) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const onNew = (value: string) => {
      const cut = value.search(/\s[-–—]\s/)
      void add($, cut > 0 ? value.slice(0, cut) : value, cut > 0 ? value.slice(cut + 3) : undefined)
    }
    // O app de celular ainda não desenha campos de texto.
    const newField = (() => {
      if (e.surface === 'mobile') return undefined
      const { Input } = $.ui.resolve(e)
      return <Input key="new" placeholder="Nova tarefa (título - contexto)" submitLabel="Adicionar" onSubmit={onNew} />
    })()
    const b = await read($, board)
    const last = await read($, notice)
    const open = (b?.tasks ?? []).filter(t => !t.done)
    const done = (b?.tasks ?? []).filter(t => t.done).slice(0, 5)
    const section = (name: Section, label: string) => {
      const list = open.filter(t => t.section === name)
      if (list.length === 0) return undefined
      return (
        <Box key={`s-${name}`} flexDirection="column" marginTop={1}>
          <Text bold>
            {label} ({list.length})
          </Text>
          {list.map(t => (
            <Box key={`t-${t.id}`} flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text>
                ○ {t.title}
                {t.context ? <Text dimColor> — {t.context}</Text> : ''}
              </Text>
              {name === 'Someday' ? (
                <Button key={`up-${t.id}`} label="↑" plain onPress={() => void activate($, t.id)} />
              ) : (
                <Button key={`go-${t.id}`} label="Começar" plain onPress={() => void $.prompt.fill({ text: startPrompt(t) })} />
              )}
              <Button key={`ok-${t.id}`} label="✓" plain onPress={() => void complete($, t.id)} />
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {b?.exists ? `${b.path} · ${open.length} aberta${open.length === 1 ? '' : 's'}` : `Sem TASKS.md em ${where.root || 'esta pasta'}: a primeira tarefa cria o arquivo.`}
        </Text>
        {newField}
        {section('Active', 'Ativas')}
        {section('Waiting On', 'Aguardando')}
        {section('Someday', 'Algum dia')}
        {done.length > 0 && (
          <Box key="done" flexDirection="column" marginTop={1}>
            <Text dimColor>Feitas</Text>
            {done.map(t => (
              <Text key={`d-${t.id}`} dimColor>
                ✓ {t.title}
                {t.doneAt ? ` (${t.doneAt})` : ''}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="row" columnGap={2} marginTop={1}>
          <Button key="import" label="Importar pendências" onPress={() => void importPending($)} />
          <Button key="reload" label="↻" plain onPress={() => void load($, true)} />
        </Box>
        {last && <Text dimColor>{last}</Text>}
      </Box>
    )
  })

  // Acima do prompt: a próxima tarefa ativa, empilhada com o que outros plugins desenham.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!showBand || e.props.hasSurvey) return below
    const b = await read($, board)
    const open = (b?.tasks ?? []).filter(t => !t.done)
    const first = open.find(t => t.section === 'Active')
    if (!b?.exists || open.length === 0) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const nextTask = findTask(open, first?.id ?? '') ?? first

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
          <Text>
            {nextTask ? (
              <Text>
                <Text bold>▶ Próxima:</Text> {nextTask.title}
              </Text>
            ) : (
              <Text dimColor>Sem tarefas ativas</Text>
            )}
            <Text dimColor> · {open.length} aberta{open.length === 1 ? '' : 's'}</Text>
          </Text>
          {nextTask && <Button key="tarefa-go" label="Começar" plain onPress={() => void $.prompt.fill({ text: startPrompt(nextTask) })} />}
          {nextTask && <Button key="tarefa-ok" label="✓ Feita" plain onPress={() => void complete($, nextTask.id)} />}
          <Button key="tarefa-list" label="Tarefas" plain onPress={() => void $.ui.open({ id: PANE, title: 'Tarefas' })} />
        </Box>
        {below}
      </Box>
    )
  })
}
