import type { CompileError, TestCase, TestRun } from '../types'

// ---------- caminhos ----------

export const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')

export const join = (...parts: string[]) =>
  parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? norm(p) : norm(p).replace(/^\/+/, '')))
    .join('/')

export const dirname = (p: string) => {
  const n = norm(p)
  const i = n.lastIndexOf('/')

  return i <= 0 ? n.slice(0, i + 1) : n.slice(0, i)
}

export const isUnder = (root: string, path: string) =>
  norm(path).toLowerCase().startsWith(`${norm(root).toLowerCase()}/`)

/** Caminho relativo à raiz do projeto Unity, com `/`. */
export const rel = (root: string, path: string) => (isUnder(root, path) ? norm(path).slice(norm(root).length + 1) : norm(path))

/** As pastas de cima, da mais funda à raiz: candidatos a raiz do projeto. */
export const ancestors = (dir: string): string[] => {
  const out: string[] = []
  let cur = norm(dir)
  while (cur && !out.includes(cur)) {
    out.push(cur)
    const up = dirname(cur)
    if (up === cur) break
    cur = up
  }

  return out
}

/** `m_EditorVersion: 6000.6.3f1` → `6000.6.3f1`. */
export const editorVersion = (projectVersionTxt: string) => /m_EditorVersion:\s*(\S+)/.exec(projectVersionTxt)?.[1]

export const defaultEditorPath = (version: string, isWindows: boolean) =>
  isWindows
    ? `C:/Program Files/Unity/Hub/Editor/${version}/Editor/Unity.exe`
    : `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/MacOS/Unity`

/** A pasta `PlaybackEngines` do editor (os módulos de plataforma instalados). */
export const playbackEngines = (editorPath: string, isWindows: boolean) =>
  isWindows
    ? join(dirname(editorPath), 'Data/PlaybackEngines')
    : join(dirname(dirname(dirname(dirname(editorPath)))), 'PlaybackEngines')

// ---------- assemblies e compilação ----------

/** Assembly padrão de um script sem .asmdef acima dele. */
export const defaultAssembly = (relPath: string) =>
  /(^|\/)Editor\//.test(relPath) ? 'Assembly-CSharp-Editor' : 'Assembly-CSharp'

export const asmdefName = (json: string) => {
  try {
    const name = (JSON.parse(json) as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return /"name"\s*:\s*"([^"]+)"/.exec(json)?.[1]
  }
}

/** Se o .csproj gerado pelo Unity já lista o arquivo. */
export const csprojHas = (csproj: string, relPath: string) => {
  const a = relPath.replaceAll('\\', '/')

  return csproj.includes(`"${a}"`) || csproj.includes(`"${a.replaceAll('/', '\\')}"`)
}

/** Os .csproj que este referencia (`<ProjectReference Include="X.csproj">`). */
export const projectReferences = (csproj: string): string[] =>
  [...csproj.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)].map(m =>
    (m[1] ?? '').replaceAll('\\', '/').split('/').pop()!.replace(/\.csproj$/, ''),
  )

/**
 * Um .targets que o MSBuild importa no fim do .csproj do Unity
 * (CustomAfterMicrosoftCommonTargets) para compilar arquivos novos que o
 * Unity ainda não pôs na lista, sem escrever nada dentro do projeto.
 */
export const extraTargets = (absPaths: string[]) =>
  `<Project>\n  <ItemGroup>\n${absPaths
    .map(p => `    <Compile Include="${p.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" />`)
    .join('\n')}\n  </ItemGroup>\n</Project>\n`

const ERROR_LINE = /^(.+?)\((\d+),(\d+)\):\s*error\s+(CS\d+):\s*(.+?)(?:\s+\[[^\]]+\])?$/

/** Erros do `dotnet build`, sem repetidos e sem "arquivo não encontrado" de scripts apagados. */
export const parseCompileErrors = (output: string, root: string): CompileError[] => {
  const seen = new Set<string>()
  const out: CompileError[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR_LINE.exec(line.trim())
    if (!m || m[4] === 'CS2001') continue
    const error: CompileError = {
      file: rel(root, m[1] ?? ''),
      line: Number(m[2]),
      column: Number(m[3]),
      code: m[4] ?? '',
      message: m[5] ?? '',
    }
    const key = `${error.file}:${error.line}:${error.column}:${error.code}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(error)
  }

  return out
}

export const formatErrors = (asm: string, errors: CompileError[], limit = 20) => {
  const lines = errors
    .slice(0, limit)
    .map(e => `- ${e.file}(${e.line},${e.column}): ${e.code} ${e.message}`)
  if (errors.length > limit) lines.push(`- … e mais ${errors.length - limit}`)

  return (
    `Compilação Unity (${asm}, via dotnet build): ${errors.length} erro${errors.length === 1 ? '' : 's'}.\n` +
    `${lines.join('\n')}\n` +
    'Se você ainda está no meio de uma mudança em vários arquivos, alguns podem ser transitórios.'
  )
}

// ---------- testes (XML do NUnit que o Unity grava) ----------

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

const unescapeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')

export const parseTestResults = (xml: string, platform: string): TestRun | undefined => {
  const run = /<test-run\b[^>]*>/.exec(xml)?.[0]
  if (!run) return undefined
  const failures: TestCase[] = []
  for (const m of xml.matchAll(/<test-case\b([^>]*)>([\s\S]*?)<\/test-case>/g)) {
    const tag = m[1] ?? ''
    if (attr(tag, 'result') !== 'Failed') continue
    const body = m[2] ?? ''
    const message = /<message>([\s\S]*?)<\/message>/.exec(body)?.[1]
    const stack = /<stack-trace>([\s\S]*?)<\/stack-trace>/.exec(body)?.[1]
    failures.push({
      name: unescapeXml(attr(tag, 'fullname') ?? attr(tag, 'name') ?? '?'),
      message: unescapeXml(message ?? '').trim(),
      stack: unescapeXml(stack ?? '')
        .trim()
        .split(/\r?\n/)
        .slice(0, 4)
        .join('\n'),
    })
  }

  return {
    platform,
    total: Number(attr(run, 'total') ?? 0),
    passed: Number(attr(run, 'passed') ?? 0),
    failed: Number(attr(run, 'failed') ?? 0),
    skipped: Number(attr(run, 'skipped') ?? 0),
    durationSec: Number(attr(run, 'duration') ?? 0),
    failures,
  }
}

/** O motivo de o Unity não ter rodado, lido do log. */
export const unityLogProblem = (log: string): string | undefined => {
  if (/another Unity instance is running|Multiple Unity instances cannot open the same project/i.test(log)) {
    return 'O projeto está aberto no Unity Editor. Feche o editor para rodar em batch, ou use o Test Runner dentro dele.'
  }
  if (/No valid Unity Editor license found|Licen[sc]e.*(not|in)valid|User is not logged in/i.test(log)) {
    return 'O Unity não achou uma licença válida. Abra o Unity Hub e entre na conta.'
  }
  if (/Scripts have compiler errors/i.test(log)) {
    return 'Os scripts têm erros de compilação; corrija antes de rodar os testes.'
  }

  return undefined
}

export const testSummary = (r: TestRun) =>
  `${r.platform} ${r.passed}/${r.total}${r.failed > 0 ? ` · ${r.failed} falha${r.failed === 1 ? '' : 's'}` : ' ✓'}`

export const failuresText = (r: TestRun, limit = 10) =>
  r.failures
    .slice(0, limit)
    .map(f => `- ${f.name}\n  ${f.message.split('\n')[0] ?? ''}${f.stack ? `\n  ${f.stack.split('\n')[0]}` : ''}`)
    .join('\n')

// ---------- guardas ----------

export type GuardInput = {
  tool: string
  /** Arquivo que a ferramenta escreve. */
  path?: string
  /** O texto novo (Write: conteúdo; Edit: new_string). */
  newText?: string
  /** Se o arquivo já existe (para .meta). */
  exists?: boolean
  /** O comando do Bash. */
  command?: string
}

export type GuardConfig = { root: string; coreDir: string; allowSceneEdits: boolean }

const GENERATED = ['Library', 'Temp', 'Logs', 'obj', 'UserSettings']

/** O motivo para recusar a chamada, ou undefined para deixar passar. */
export const guard = (input: GuardInput, cfg: GuardConfig): string | undefined => {
  if (input.command !== undefined) {
    const deletes = /(^|[;&|]\s*|\s)(git\s+rm|rm|del|erase|Remove-Item|rd|rmdir)\s/i.test(` ${input.command}`)
    if (deletes && /\.meta\b/i.test(input.command)) {
      return 'unity-tools: não apague arquivos .meta pelo terminal. Apague o asset junto com o .meta, ou deixe o Unity cuidar disso.'
    }
    return undefined
  }

  if (!input.path || !isUnder(cfg.root, input.path)) return undefined
  const r = rel(cfg.root, input.path)
  const top = r.split('/')[0] ?? ''

  if (GENERATED.includes(top)) {
    return `unity-tools: ${top}/ é gerado pelo Unity e não deve ser editado (${r}).`
  }
  if (!cfg.allowSceneEdits && /\.(unity|prefab)$/i.test(r)) {
    return (
      `unity-tools: não reescreva cenas ou prefabs à mão (${r}). Crie ou altere por um script de editor ` +
      'ou no próprio Unity.'
    )
  }
  if (/\.meta$/i.test(r) && input.tool === 'Write' && input.exists === false) {
    return `unity-tools: não crie .meta à mão (${r}); o Unity gera o .meta e o GUID quando importa o asset.`
  }

  const core = norm(cfg.coreDir)
  if (core && (r === core || r.startsWith(`${core}/`))) {
    const text = input.newText ?? ''
    if (/\.cs$/i.test(r) && /\busing\s+(static\s+)?UnityEngine\b|\bUnityEngine\s*\./.test(text)) {
      return (
        `unity-tools: ${core} é o núcleo de regras sem engine (asmdef com noEngineReferences). ` +
        'Não use UnityEngine aqui; ponha o código que depende da engine em Game e chame o núcleo de lá.'
      )
    }
    if (/\.asmdef$/i.test(r) && /"noEngineReferences"\s*:\s*false/.test(text)) {
      return `unity-tools: o asmdef do núcleo (${r}) deve manter "noEngineReferences": true.`
    }
  }

  return undefined
}
