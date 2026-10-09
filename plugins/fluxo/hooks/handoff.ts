import type { Handoff } from '../types'

export type GitInfo = { branch: string; dirty: number; lastCommit: string } | null

export type HandoffInput = {
  project: string
  machine: string
  at: number
  summary: string | null
  summaryAt: number | null
  edited: string[]
  git: GitInfo
  /** As tarefas abertas do TASKS.md (mod tarefas), se houver. */
  tasks?: string[]
}

/** As tarefas abertas das seções Active e Waiting On de um TASKS.md. */
export const openTasks = (text: string): string[] => {
  const out: string[] = []
  let take = false
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      take = /^(active|ativas|em andamento|waiting on|aguardando)$/i.test(h[1] ?? '')
      continue
    }
    const m = /^[-*]\s+\[ \]\s+(.*)$/.exec(line)
    if (take && m) out.push((m[1] ?? '').replace(/\*\*/g, '').trim())
  }

  return out
}

const HEADER = /<!--\s*fluxo-handoff machine="([^"]*)" at="([^"]*)"\s*-->/

const pad = (n: number) => String(n).padStart(2, '0')

export const stamp = (t: number) => {
  const d = new Date(t)

  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** O arquivo de handoff, em markdown, com um cabeçalho que a outra máquina lê. */
export const formatHandoff = (h: HandoffInput): string => {
  const lines = [
    `<!-- fluxo-handoff machine="${h.machine.replaceAll('"', "'")}" at="${new Date(h.at).toISOString()}" -->`,
    `# Handoff · ${h.project} · ${h.machine} · ${stamp(h.at)}`,
    '',
  ]
  if (h.summary) {
    lines.push(h.summary.trim(), '')
    if (h.summaryAt !== null && h.summaryAt < h.at - 60_000) {
      lines.push(`_Resumo de ${stamp(h.summaryAt)}; houve trabalho depois dele._`, '')
    }
  } else {
    lines.push('_Sem resumo: rode `/handoff` para gerar um._', '')
  }
  if (h.tasks && h.tasks.length > 0) {
    lines.push('## Tarefas abertas (TASKS.md)')
    lines.push(...h.tasks.slice(0, 20).map(t => `- [ ] ${t}`))
    if (h.tasks.length > 20) lines.push(`- … e mais ${h.tasks.length - 20}`)
    lines.push('')
  }
  lines.push('## Arquivos alterados nesta sessão')
  lines.push(...(h.edited.length > 0 ? h.edited.slice(0, 60).map(f => `- ${f}`) : ['- nenhum']))
  if (h.edited.length > 60) lines.push(`- … e mais ${h.edited.length - 60}`)
  lines.push('', '## Git')
  lines.push(
    h.git
      ? `Branch \`${h.git.branch}\` · ${h.git.dirty} arquivo${h.git.dirty === 1 ? '' : 's'} sem commit · último commit: ${h.git.lastCommit || '—'}`
      : 'Pasta sem git: leve o arquivo junto com o projeto (pasta sincronizada ou cópia).',
  )

  return `${lines.join('\n')}\n`
}

/** Lê o cabeçalho de um handoff; undefined quando o arquivo não é um. */
export const parseHandoff = (text: string): Handoff | undefined => {
  const m = HEADER.exec(text)
  if (!m) return undefined
  const at = Date.parse(m[2] ?? '')

  return { machine: m[1] ?? '?', at: Number.isNaN(at) ? 0 : at, text }
}

/** A primeira frase de "Onde parei", ou o título. */
export const headline = (h: Handoff): string => {
  const section = /##\s*Onde parei\s*\n+([^\n#]+)/.exec(h.text)
  const line = section?.[1] ?? /^#\s+(.+)$/m.exec(h.text)?.[1] ?? ''

  return line.trim().replace(/^[-*]\s+/, '').slice(0, 160)
}

export const ago = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `há ${minutes}min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `há ${hours}h`

  return `há ${Math.round(hours / 24)} dias`
}

export const duration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)

  return m < 60 ? `${m}min${s % 60 ? ` ${s % 60}s` : ''}` : `${Math.floor(m / 60)}h${pad(m % 60)}`
}

/** `/home/dev/my-game/client/x.cs` com raiz `/home/dev/my-game` → `client/x.cs`. */
export const relative = (root: string, file: string): string => {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(file)

  return f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f
}

export const joinPath = (root: string, rel: string) =>
  `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`

export const SUMMARY_SYSTEM =
  'Você escreve passagens de bastão curtas, em português do Brasil, para alguém continuar um trabalho de ' +
  'desenvolvimento em outra máquina. Seja concreto: nomes de arquivos, comandos, decisões. Sem introdução.'

export const summaryPrompt = (transcript: string, note: string) =>
  `Conversa da sessão (mais recente no fim):\n\n${transcript}\n\n` +
  (note ? `Observação de quem pediu o handoff: ${note}\n\n` : '') +
  'Escreva em markdown exatamente estas seções:\n' +
  '## Onde parei\n(1 a 3 frases: o que estava em andamento e o estado atual)\n' +
  '## Feito nesta sessão\n(até 6 tópicos)\n' +
  '## Próximos passos\n(até 5 tópicos, em ordem)\n' +
  '## Cuidados\n(só se houver: decisões tomadas, armadilhas, comandos que importam)'
