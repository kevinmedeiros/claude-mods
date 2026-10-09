import type { Section, Task } from '../types'

/**
 * O formato do TASKS.md, o mesmo da skill de tarefas do Claude:
 *   ## Active / ## Waiting On / ## Someday / ## Done
 *   - [ ] **Título** - contexto
 *   - [x] ~~Título~~ (2026-10-09)
 * O mod mexe só nas linhas das tarefas que muda; o resto do arquivo fica como está.
 */
export const TEMPLATE = '# Tasks\n\n## Active\n\n## Waiting On\n\n## Someday\n\n## Done\n'

export const SECTIONS: Section[] = ['Active', 'Waiting On', 'Someday', 'Done']

const SECTION_ALIASES: Record<string, Section> = {
  active: 'Active',
  ativas: 'Active',
  'em andamento': 'Active',
  'waiting on': 'Waiting On',
  aguardando: 'Waiting On',
  someday: 'Someday',
  'algum dia': 'Someday',
  backlog: 'Someday',
  done: 'Done',
  feitas: 'Done',
  concluídas: 'Done',
}

const HEADING = /^(#{1,6})\s+(.+?)\s*$/
const TASK = /^([-*])\s+\[( |x|X)\]\s+(.*)$/

/** "Portar a esquiva!" → "portar a esquiva": a chave para achar e não duplicar. */
export const taskId = (title: string) =>
  title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const clean = (s: string) => s.replace(/~~/g, '').replace(/\*\*/g, '').replace(/`/g, '').trim()

/** Título e contexto de uma linha: o negrito é o título; sem negrito, o que vem antes de " - ". */
export const splitTitle = (raw: string): { title: string; context?: string; doneAt?: string } => {
  let text = raw.trim()
  const date = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(text)
  if (date) text = text.slice(0, date.index).trim()
  const bold = /^(?:~~)?\*\*(.+?)\*\*(?:~~)?\s*(?:[-–—:]\s*(.*))?$/.exec(text)
  if (bold) return { title: clean(bold[1] ?? ''), context: bold[2] ? clean(bold[2]) : undefined, doneAt: date?.[1] }
  const cut = text.search(/\s[-–—]\s/)
  if (cut > 0) return { title: clean(text.slice(0, cut)), context: clean(text.slice(cut + 3)), doneAt: date?.[1] }

  return { title: clean(text), doneAt: date?.[1] }
}

const sectionOf = (name: string): Section | undefined => SECTION_ALIASES[name.toLowerCase().trim()]

export const parseTasks = (text: string): Task[] => {
  const lines = text.split('\n')
  const tasks: Task[] = []
  let section: Section | undefined
  lines.forEach((line, i) => {
    const h = HEADING.exec(line)
    if (h && (h[1] ?? '').length === 2) {
      section = sectionOf(h[2] ?? '')
      return
    }
    const m = TASK.exec(line)
    if (!m || !section) return
    const parts = splitTitle(m[3] ?? '')
    if (!parts.title) return
    tasks.push({
      id: taskId(parts.title),
      title: parts.title,
      context: parts.context,
      done: (m[2] ?? ' ').toLowerCase() === 'x',
      section,
      line: i,
      doneAt: parts.doneAt,
    })
  })

  return tasks
}

/** Onde termina o bloco da tarefa na linha `start` (ela e os sub-itens indentados). */
const blockEnd = (lines: string[], start: number) => {
  let end = start + 1
  while (end < lines.length && /^\s{2,}\S/.test(lines[end] ?? '')) end++

  return end
}

/** A linha onde entra uma tarefa nova no fim de uma seção (cria a seção se faltar). */
const insertionPoint = (lines: string[], section: Section): { lines: string[]; at: number } => {
  let header = lines.findIndex(l => {
    const h = HEADING.exec(l)
    return h !== null && (h[1] ?? '').length === 2 && sectionOf(h[2] ?? '') === section
  })
  let out = lines
  if (header < 0) {
    // Seção nova: antes de "## Done" se houver, senão no fim.
    const done = lines.findIndex(l => /^##\s+(done|feitas|concluídas)\s*$/i.test(l))
    const block = [`## ${section}`, '']
    out = done >= 0 ? [...lines.slice(0, done), ...block, ...lines.slice(done)] : [...lines, '', ...block]
    header = done >= 0 ? done : out.length - 2
  }
  let at = header + 1
  let last = header
  while (at < out.length && !/^#{1,2}\s/.test(out[at] ?? '')) {
    if ((out[at] ?? '').trim()) last = at
    at++
  }

  return { lines: out, at: last + 1 }
}

const taskLine = (title: string, context?: string) =>
  `- [ ] **${title.replace(/\*\*/g, '')}**${context ? ` - ${context.replace(/\n/g, ' ')}` : ''}`

export type AddResult = { text: string; added: boolean; task?: Task }

/** Acrescenta uma tarefa aberta na seção; não duplica uma aberta com o mesmo título. */
export const addTask = (
  text: string | undefined,
  input: { title: string; context?: string; section?: Section },
): AddResult => {
  const base = text && text.trim() ? text : TEMPLATE
  const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 160)
  if (!title) return { text: base, added: false }
  const existing = parseTasks(base).find(t => !t.done && t.id === taskId(title))
  if (existing) return { text: base, added: false, task: existing }
  const { lines, at } = insertionPoint(base.replace(/\n+$/, '').split('\n'), input.section ?? 'Active')
  const next = [...lines.slice(0, at), taskLine(title, input.context), ...lines.slice(at)]
  const out = `${next.join('\n')}\n`

  return { text: out, added: true, task: parseTasks(out).find(t => !t.done && t.id === taskId(title)) }
}

/** Acha a tarefa pelo id ou por um pedaço do título (abertas primeiro). */
export const findTask = (tasks: Task[], query: string): Task | undefined => {
  const q = taskId(query)
  if (!q) return undefined
  const ordered = [...tasks.filter(t => !t.done), ...tasks.filter(t => t.done)]

  const words = q.split(' ').filter(w => w.length > 1)
  const hasAllWords = (t: Task) => words.length > 0 && words.every(w => t.id.split(' ').some(x => x.startsWith(w)))

  return (
    ordered.find(t => t.id === q) ??
    ordered.find(t => t.id.includes(q)) ??
    ordered.find(t => q.includes(t.id)) ??
    ordered.find(hasAllWords)
  )
}

const removeBlock = (lines: string[], start: number) => {
  const end = blockEnd(lines, start)
  return { rest: [...lines.slice(0, start), ...lines.slice(end)], block: lines.slice(start, end) }
}

/** Marca como feita: risca, põe a data e move para o topo de "## Done". */
export const completeTask = (text: string, query: string, date: string): { text: string; task?: Task } => {
  const task = findTask(parseTasks(text), query)
  if (!task || task.done) return { text, task }
  const { rest, block } = removeBlock(text.replace(/\n+$/, '').split('\n'), task.line)
  const doneLine = `- [x] ~~${task.title}~~${task.context ? ` - ${task.context}` : ''} (${date})`
  const doneBlock = [doneLine, ...block.slice(1)]
  let lines = rest
  let header = lines.findIndex(l => /^##\s+(done|feitas|concluídas)\s*$/i.test(l))
  if (header < 0) {
    lines = [...lines, '', '## Done']
    header = lines.length - 1
  }
  const at = header + 1 < lines.length && !(lines[header + 1] ?? '').trim() ? header + 2 : header + 1
  const out = [...lines.slice(0, at), ...doneBlock, ...lines.slice(at)]

  return { text: `${out.join('\n')}\n`, task: { ...task, done: true, section: 'Done', doneAt: date } }
}

/** Move uma tarefa aberta para outra seção (ex.: de Someday para Active). */
export const moveTask = (text: string, query: string, section: Section): { text: string; task?: Task } => {
  const task = findTask(parseTasks(text), query)
  if (!task || task.done || task.section === section) return { text, task }
  const { rest, block } = removeBlock(text.replace(/\n+$/, '').split('\n'), task.line)
  const { lines, at } = insertionPoint(rest, section)
  const out = [...lines.slice(0, at), ...block, ...lines.slice(at)]

  return { text: `${out.join('\n')}\n`, task: { ...task, section } }
}

// ---------- importar pendências de outros arquivos ----------

export type Pending = { title: string; context?: string; source: string }

const PENDING_HEADING =
  /^(pendente|pendentes|pendências|pendencias|to ?do|a fazer|próximos passos|proximos passos|next steps|now|next|agora|em andamento|in progress|backlog)\b/i

const toPending = (raw: string, source: string): Pending | undefined => {
  const text = raw.replace(/^\[( |x|X)\]\s+/, '').trim()
  if (!text) return undefined
  const bold = /^\*\*(.+?)\*\*[:.]?\s*(.*)$/.exec(text)
  let title: string
  let context: string | undefined
  if (bold) {
    title = clean(bold[1] ?? '')
    context = clean(bold[2] ?? '') || undefined
  } else {
    const cut = text.search(/[:.]\s|\s[-–—]\s/)
    title = clean(cut > 0 ? text.slice(0, cut) : text)
    context = cut > 0 ? clean(text.slice(cut + 2)) || undefined : undefined
  }
  if (!title) return undefined

  return {
    title: title.replace(/[.:]$/, '').slice(0, 120),
    context: context && context.length > 160 ? `${context.slice(0, 157)}…` : context,
    source,
  }
}

/**
 * Itens de primeiro nível sob títulos como "Pendente", "Próximos passos",
 * "Backlog" ou "Now/Next", e caixas de seleção ainda abertas (`- [ ]`).
 */
export const extractPending = (text: string, source: string): Pending[] => {
  const out: Pending[] = []
  let level = 0
  let inside = false
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line)
    if (h) {
      const depth = (h[1] ?? '').length
      if (inside && depth <= level) inside = false
      if (PENDING_HEADING.test(clean(h[2] ?? ''))) {
        inside = true
        level = depth
      }
      continue
    }
    const open = /^[-*]\s+\[ \]\s+(.*)$/.exec(line)
    if (open) {
      const p = toPending(open[1] ?? '', source)
      if (p) out.push(p)
      continue
    }
    const bullet = /^[-*]\s+(?!\[[xX]\])(.*)$/.exec(line)
    if (inside && bullet) {
      const p = toPending(bullet[1] ?? '', source)
      if (p) out.push(p)
    }
  }

  return out
}

/** Os arquivos que valem para importar: markdown da raiz e de docs/, menos os de projeto. */
export const isImportable = (name: string) =>
  /\.md$/i.test(name) && !/^(tasks|readme|changelog|license|contributing|code_of_conduct|security)(\.|-)/i.test(name)
