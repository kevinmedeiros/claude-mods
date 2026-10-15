/**
 * O roadmap num ROADMAP.md: fases como títulos (## Fase 2 · Beta) e itens como caixas
 * (- [ ] Login por email @Claude). Lê para o mesmo modelo do JSON, então o quadro, a
 * faixa e as ferramentas não mudam; grava mexendo só na linha do item.
 *
 *   # Lighthouse
 *   Até o beta.
 *   Dono: Sam
 *
 *   ## Fase 1 · Protótipo
 *   - [x] Tela inicial (2026-09-20)
 *
 *   ## Fase 2 · Beta fechado
 *   > Gate: dez pessoas usando por uma semana
 *   - [x] Sincronizar notas
 *   - [ ] Login por email @Claude (em andamento)
 *   - [ ] Conta na loja @ambos (bloqueado: aprovação do cartão)
 *   - [ ] Convidar os testadores @Sam (depois de: Login por email)
 *
 *   ## Decisões
 *   - Cobrar assinatura? (fase 3)
 */
import type { Decision, Item, ItemStatus, Phase, PhaseStatus, Roadmap } from '../types'
import { ITEM_LABEL, ITEM_STATUSES, PHASE_LABEL, PHASE_STATUSES, eolOf, phaseLabel, slugify, stripBom } from './roadmap'
import type { AddInput, Change, Parsed, UpdateInput } from './roadmap'

export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path)

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const CHECKBOX = /^(\s*)[-*+]\s+\[([ xX~/\-])\]\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const OWNER_LINE = /^(?:dono|owner|respons[aá]vel)\s*:\s*(.+)$/i
const GATE_LINE = /^>?\s*(?:gate|port[aã]o)\s*:\s*(.+)$/i
const PHASE_WORD = /^(?:fase|phase|etapa|marco|milestone|sprint)\b/i
const DECISIONS = /^(?:decis[oõ]es|decisions|decis[oõ]es em aberto|open decisions)\b/i
const BOTH = /^(?:ambos|both|todos)$/i

/** Um item como está na linha: o que o mod entende e o resto, para regravar igual. */
type Line = {
  indent: string
  box: string
  title: string
  owner?: string
  status: ItemStatus
  doneAt?: string
  evidence?: string
  waitingOn?: string
  /** O texto de "(depois de: …)", como está no arquivo. */
  after?: string
  gate: boolean
}

/** Tira os marcadores do fim do texto do item: "(em andamento)", "(bloqueado: x)", "@Claude"… */
const readLine = (indent: string, box: string, text: string): Line => {
  const line: Line = { indent, box, title: text.trim(), status: 'todo', gate: false }
  if (box === 'x' || box === 'X') line.status = 'done'
  else if (box === '~' || box === '/') line.status = 'doing'
  else if (box === '-') line.status = 'blocked'
  let rest = line.title
  for (let guard = 0; guard < 8; guard++) {
    const owner = /\s@([\p{L}\p{N}_.-]+)$/u.exec(rest)
    if (owner) {
      line.owner = BOTH.test(owner[1]!) ? 'both' : owner[1]
      rest = rest.slice(0, owner.index).trimEnd()
      continue
    }
    const paren = /\s*\(([^()]*)\)$/.exec(rest)
    if (!paren) break
    const inside = paren[1]!.trim()
    const [head, ...tail] = inside.split(/\s*[:·—]\s*/)
    const key = (head ?? '').toLowerCase()
    const value = tail.join(': ').trim()
    if (/^(em andamento|fazendo|doing|in progress|andando)$/.test(key)) line.status = line.status === 'done' ? 'done' : 'doing'
    else if (/^(bloqueado|bloqueada|esperando|aguardando|blocked|waiting)$/.test(key)) {
      if (line.status !== 'done') line.status = 'blocked'
      if (value) line.waitingOn = value
    } else if (/^(depois de|ap[oó]s|after|depende de|depends on)$/.test(key)) line.after = value
    else if (key === 'gate' || key === 'portão' || key === 'portao') line.gate = true
    else if (/^(feito|feita|done|concluído|concluido)$/.test(key) || DATE.test(key)) {
      // "(2026-10-02)", "(feito 2026-10-02 · commit abc)", "(feito: 2026-10-02)"
      const parts = inside.replace(/^(feito|feita|done|concluído|concluido)\s*:?\s*/i, '').split(/\s*·\s*/)
      if (parts[0] && DATE.test(parts[0])) {
        line.doneAt = parts[0]
        if (parts.length > 1) line.evidence = parts.slice(1).join(' · ')
      } else if (parts.join('').trim()) line.evidence = parts.join(' · ')
      if (line.status !== 'done') line.status = 'done'
    } else if (/^\d{4}-\d{2}-\d{2}\s*·/.test(inside)) {
      const parts = inside.split(/\s*·\s*/)
      line.doneAt = parts[0]
      line.evidence = parts.slice(1).join(' · ')
    } else break
    rest = rest.slice(0, paren.index).trimEnd()
  }
  line.title = rest || line.title

  return line
}

/** A linha de volta, com os marcadores na ordem do mod: @dono, estado, depois de, gate. */
const writeLine = (l: Line): string => {
  const box = l.status === 'done' ? 'x' : l.box === '~' || l.box === '/' ? (l.status === 'doing' ? l.box : ' ') : ' '
  const marks: string[] = []
  if (l.owner) marks.push(`@${l.owner === 'both' ? 'ambos' : l.owner}`)
  if (l.status === 'doing' && box === ' ') marks.push('(em andamento)')
  if (l.status === 'blocked') marks.push(l.waitingOn ? `(bloqueado: ${l.waitingOn})` : '(bloqueado)')
  if (l.after) marks.push(`(depois de: ${l.after})`)
  if (l.gate) marks.push('(gate)')
  if (l.status === 'done' && (l.doneAt || l.evidence)) marks.push(`(${[l.doneAt, l.evidence].filter(Boolean).join(' · ')})`)

  return `${l.indent}- [${box}] ${[l.title, ...marks].join(' ')}`
}

/** "Fase 2 · Beta fechado (atual)" → id 2, nome "Beta fechado", estado pedido. */
const readHeading = (text: string, index: number): { id: string; name: string; status?: PhaseStatus; mark?: string } => {
  let rest = text.trim()
  let status: PhaseStatus | undefined
  const mark = /\s*(?:\((feita|feito|conclu[ií]da|done|atual|em andamento|doing)\)|(✓|✅))\s*$/i.exec(rest)
  if (mark) {
    const word = (mark[1] ?? mark[2] ?? '').toLowerCase()
    status = /atual|andamento|doing/.test(word) ? 'doing' : 'done'
    rest = rest.slice(0, mark.index).trim()
  }
  const numbered = /^(?:(?:fase|phase|etapa|marco|milestone|sprint)\s*)?([A-Za-z]?\d+(?:\.\d+)?)\s*(?:[·:—–.)-]\s*|\s+)(.*)$/i.exec(rest)
  if (numbered && numbered[1]) return { id: numbered[1], name: numbered[2]!.trim(), status }
  const bare = /^(?:fase|phase|etapa|marco|milestone|sprint)\s+([A-Za-z]?\d+)$/i.exec(rest)
  if (bare && bare[1]) return { id: bare[1], name: '', status }

  return { id: String(index + 1), name: rest.replace(PHASE_WORD, '').replace(/^\s*[·:—–-]\s*/, '').trim() || rest, status }
}

/** O que o parser guarda para gravar depois: a linha de cada item e de cada fase. */
type Located = {
  roadmap: Roadmap
  lines: string[]
  itemLine: Map<string, number>
  phaseLine: Map<string, number>
  /** A última linha do bloco de cada item (com as sub-listas). */
  itemEnd: Map<string, number>
  /** Onde entra um item novo da fase, se ela ainda não tem nenhum. */
  phaseEnd: Map<string, number>
  gateLine: Map<string, number>
}

const locate = (raw: string): Located | { error: string } => {
  const lines = stripBom(raw).split(/\r?\n/)
  const headings: { at: number; level: number; text: string }[] = []
  let inFence = false
  lines.forEach((l, at) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence
    if (inFence) return
    const h = HEADING.exec(l)
    if (h) headings.push({ at, level: h[1]!.length, text: h[2]! })
  })
  const isItem = (at: number) => !insideFence(lines, at) && CHECKBOX.test(lines[at]!)
  const itemAts = lines.map((_, at) => at).filter(isItem)
  if (itemAts.length === 0) {
    return {
      error:
        'o ROADMAP.md não tem nenhum item em caixa de seleção. O mod lê fases como títulos (## Fase 1 · Nome) e itens como "- [ ] Título" embaixo deles',
    }
  }
  const nearest = (at: number) => [...headings].reverse().find(h => h.at < at)
  const titleH1 = headings.filter(h => h.level === 1)
  const levels = itemAts.map(at => nearest(at)?.level).filter((n): n is number => n !== undefined && !(n === 1 && titleH1.length === 1))
  const phaseLevel = levels.length > 0 ? Math.min(...levels) : 0

  const phases: Phase[] = []
  const items: Item[] = []
  const decisions: Decision[] = []
  const itemLine = new Map<string, number>()
  const itemEnd = new Map<string, number>()
  const phaseLine = new Map<string, number>()
  const phaseEnd = new Map<string, number>()
  const gateLine = new Map<string, number>()
  const explicit = new Map<string, PhaseStatus>()
  const taken = new Set<string>()
  const afterText = new Map<string, string>()
  let project: string | undefined
  let goal: string | undefined
  let owner: string | undefined
  let phase: Phase | undefined
  let inDecisions = false
  let area: string | undefined
  let lastItem: string | undefined
  inFence = false

  const newPhase = (id: string, name: string, at: number) => {
    let unique = id
    for (let n = 2; phases.some(p => p.id === unique); n++) unique = `${id}-${n}`
    const p: Phase = { id: unique, name, status: 'todo' }
    phases.push(p)
    phaseLine.set(unique, at)
    phaseEnd.set(unique, at)
    return p
  }

  lines.forEach((l, at) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence
    if (inFence) return
    const h = HEADING.exec(l)
    if (h) {
      const level = h[1]!.length
      const text = h[2]!.trim()
      lastItem = undefined
      if (level === 1 && titleH1.length === 1 && phaseLevel !== 1) {
        project = text
        return
      }
      if (level === phaseLevel || (phaseLevel === 0 && level === 2)) {
        inDecisions = DECISIONS.test(text)
        area = undefined
        if (inDecisions) {
          phase = undefined
          return
        }
        // Título no nível das fases: é fase se tem itens embaixo ou se diz "Fase N".
        const next = headings.find(x => x.at > at && x.level <= level)?.at ?? lines.length
        const hasItems = itemAts.some(i => i > at && i < next)
        if (!hasItems && !PHASE_WORD.test(text)) {
          phase = undefined
          return
        }
        const read = readHeading(text, phases.length)
        phase = newPhase(read.id, read.name, at)
        if (read.status) explicit.set(phase.id, read.status)
        return
      }
      if (level > phaseLevel) area = text
      return
    }
    // Antes da primeira fase: "Dono: Sam" e a primeira frase (o objetivo).
    if (!phase && !inDecisions && phases.length === 0) {
      const o = OWNER_LINE.exec(l.trim())
      if (o) owner = o[1]!.trim().replace(/^@/, '')
      else if (l.trim() && !goal && !CHECKBOX.test(l) && !BULLET.test(l)) goal = l.trim().replace(/^>\s*/, '')
    }
    if (inDecisions) {
      const b = BULLET.exec(l)
      if (b && !b[1]) {
        const text = b[2]!.replace(/^\[[ xX]\]\s*/, '').trim()
        const ph = /\s*\((?:fase|phase)\s+([^)]+)\)\s*$/i.exec(text)
        decisions.push({ title: ph ? text.slice(0, ph.index).trim() : text, phase: ph ? ph[1]!.trim() : undefined })
      }
      return
    }
    if (phase) {
      const g = GATE_LINE.exec(l.trim())
      if (g && !CHECKBOX.test(l)) {
        const [gate, ...status] = g[1]!.split(/\s+—\s+/)
        phase.gate = gate!.trim()
        if (status.length > 0) phase.gateStatus = status.join(' — ').trim()
        gateLine.set(phase.id, at)
        phaseEnd.set(phase.id, Math.max(phaseEnd.get(phase.id) ?? at, at))
        return
      }
    }
    const c = CHECKBOX.exec(l)
    if (c) {
      if (c[1]!.length > 0 && lastItem) {
        // Sub-caixa: vira nota do item de cima.
        itemEnd.set(lastItem, at)
        const parent = items.find(i => i.id === lastItem)!
        parent.notes = [parent.notes, c[3]!.trim()].filter(Boolean).join(' · ')
        if (phase) phaseEnd.set(phase.id, at)
        return
      }
      if (!phase) phase = newPhase('1', 'Roadmap', at - 1)
      const line = readLine(c[1]!, c[2]!, c[3]!)
      let id = slugify(line.title)
      for (let n = 2; taken.has(id); n++) id = `${slugify(line.title)}-${n}`
      taken.add(id)
      const item: Item = { id, phase: phase.id, title: line.title, status: line.status, dependsOn: [], gate: line.gate }
      if (line.owner) item.owner = line.owner
      if (line.waitingOn) item.waitingOn = line.waitingOn
      if (line.doneAt) item.doneAt = line.doneAt
      if (line.evidence) item.evidence = line.evidence
      if (area) item.area = area
      if (line.after) afterText.set(id, line.after)
      items.push(item)
      itemLine.set(id, at)
      itemEnd.set(id, at)
      phaseEnd.set(phase.id, at)
      lastItem = id
      return
    }
    // Sub-item comum embaixo de um item: nota.
    const b = BULLET.exec(l)
    if (b && b[1]!.length > 0 && lastItem) {
      const parent = items.find(i => i.id === lastItem)!
      parent.notes = [parent.notes, b[2]!.trim()].filter(Boolean).join(' · ')
      itemEnd.set(lastItem, at)
      if (phase) phaseEnd.set(phase.id, at)
      return
    }
    if (l.trim()) lastItem = undefined
  })

  // "depois de: Login por email, Tela inicial" → ids, por título ou id.
  for (const item of items) {
    const text = afterText.get(item.id)
    if (!text) continue
    for (const ref of text.split(/\s*[,;]\s*|\s+e\s+/)) {
      const slug = slugify(ref)
      const hit = items.find(i => i.id === slug) ?? items.find(i => i.id !== item.id && (i.id.startsWith(slug) || slugify(i.title).includes(slug)))
      if (hit && hit.id !== item.id) item.dependsOn.push(hit.id)
    }
  }

  // Estado das fases: o que o título diz; senão, pelos itens.
  for (const p of phases) {
    const mine = items.filter(i => i.phase === p.id)
    const said = explicit.get(p.id)
    p.status = said ?? (mine.length > 0 && mine.every(i => i.status === 'done') ? 'done' : mine.some(i => i.status !== 'todo') ? 'doing' : 'todo')
  }

  if (!owner) {
    const counts = new Map<string, number>()
    for (const i of items) if (i.owner && i.owner !== 'both' && !/^claude$/i.test(i.owner)) counts.set(i.owner, (counts.get(i.owner) ?? 0) + 1)
    owner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }

  const roadmap: Roadmap = { version: 1, phases, items, path: [], openDecisions: decisions }
  if (project) roadmap.project = project
  if (goal) roadmap.goal = goal
  if (owner) roadmap.owner = owner

  return { roadmap, lines, itemLine, phaseLine, itemEnd, phaseEnd, gateLine }
}

const insideFence = (lines: string[], at: number) => {
  let inFence = false
  for (let n = 0; n < at; n++) if (/^\s*(```|~~~)/.test(lines[n]!)) inFence = !inFence
  return inFence
}

export const parseMarkdown = (raw: string): Parsed => {
  const found = locate(raw)
  return 'error' in found ? { ok: false, error: found.error } : { ok: true, roadmap: found.roadmap }
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const join = (lines: string[], original: string) => {
  const out = lines.join(eolOf(original))
  return original.charCodeAt(0) === 0xfeff ? `﻿${out}` : out
}

/** O roadmap_update num ROADMAP.md: muda só a linha do item (ou o título da fase). */
export const applyUpdateMarkdown = (original: string, input: UpdateInput, today: string): Change => {
  const found = locate(original)
  if ('error' in found) return { ok: false, error: `O roadmap tem erro e não foi alterado (${found.error}).` }
  const { roadmap: r, lines } = found
  const id = text(input.id)
  if (!id) return { ok: false, error: 'Falta o "id" do item.' }
  if (input.short !== undefined) return { ok: false, error: 'O ROADMAP.md não guarda rótulo curto: o cartão usa o título. Encurte o título editando o arquivo, se quiser.' }
  const note = text(input.note)
  const evidence = text(input.evidence)
  const waitingOn = text(input.waitingOn)
  const item = r.items.find(i => i.id === id)

  if (!item) {
    const phase = r.phases.find(p => p.id === id)
    if (!phase) {
      const words = slugify(id).split('-').filter(w => w.length >= 3)
      const hits = r.items.filter(i => words.some(w => i.id.includes(w))).slice(0, 5)
      return { ok: false, error: `Não existe item "${id}" no roadmap.${hits.length ? ` Ids parecidos: ${hits.map(i => i.id).join(', ')}.` : ' Use roadmap_status para ver os ids.'}` }
    }
    const status = input.status ?? phase.status
    if (typeof status !== 'string' || !PHASE_STATUSES.includes(status as PhaseStatus)) {
      return { ok: false, error: `Status ${JSON.stringify(input.status)} inválido para fase: use done, doing ou todo.` }
    }
    const at = found.phaseLine.get(phase.id)!
    const h = HEADING.exec(lines[at]!)
    if (h && input.status !== undefined) {
      const bare = h[2]!.replace(/\s*(?:\((?:feita|feito|conclu[ií]da|done|atual|em andamento|doing)\)|✓|✅)\s*$/i, '')
      lines[at] = `${h[1]} ${bare}${status === 'done' ? ' (feita)' : status === 'doing' ? ' (atual)' : ''}`
    }
    if (evidence) {
      const g = found.gateLine.get(phase.id)
      if (g !== undefined) lines[g] = `> Gate: ${phase.gate ?? ''} — ${evidence}`
      else lines.splice(at + 1, 0, `> Gate: — ${evidence}`)
    }
    if (note) lines.splice((found.gateLine.get(phase.id) ?? at) + 1, 0, `> ${note}`)
    const out = join(lines, original)
    if (out === original) return { ok: true, text: original, message: `${phaseLabel(phase)} já estava assim.` }
    return { ok: true, text: out, message: `${phaseLabel(phase)} → ${PHASE_LABEL[status as PhaseStatus]}`, title: phaseLabel(phase) }
  }

  const status = input.status ?? item.status
  if (typeof status !== 'string' || !ITEM_STATUSES.includes(status as ItemStatus)) {
    return { ok: false, error: `Status ${JSON.stringify(input.status)} inválido: use done, doing, todo ou blocked.` }
  }
  if (input.doneAt !== undefined && (typeof input.doneAt !== 'string' || !DATE.test(input.doneAt))) {
    return { ok: false, error: `"doneAt" precisa ser uma data AAAA-MM-DD (recebi ${JSON.stringify(input.doneAt)}).` }
  }
  if (input.doneAt !== undefined && status !== 'done') return { ok: false, error: '"doneAt" só vale para item feito: passe status "done" junto.' }
  const at = found.itemLine.get(item.id)!
  const c = CHECKBOX.exec(lines[at]!)!
  const line = readLine(c[1]!, c[2]!, c[3]!)
  line.status = status as ItemStatus
  if (status === 'done') line.doneAt = (input.doneAt as string | undefined) ?? (item.status === 'done' ? line.doneAt : today)
  else if (input.status !== undefined) line.doneAt = undefined
  if (status !== 'blocked' && input.status !== undefined) line.waitingOn = undefined
  if (waitingOn) line.waitingOn = waitingOn
  if (evidence) line.evidence = evidence
  if (status !== 'done') line.evidence = undefined
  lines[at] = writeLine(line)
  if (note) lines.splice(found.itemEnd.get(item.id)! + 1, 0, `${line.indent}  - ${note}`)
  const out = join(lines, original)
  if (out === original) return { ok: true, text: original, message: `"${item.title}" já estava assim.`, title: item.title }

  return {
    ok: true,
    text: out,
    message: `"${item.title}" → ${ITEM_LABEL[status as ItemStatus]}${status === 'done' && line.doneAt ? ` em ${line.doneAt}` : ''}`,
    title: item.title,
  }
}

/** O roadmap_add num ROADMAP.md: uma linha nova depois de "after" ou no fim da fase. */
export const applyAddMarkdown = (original: string, input: AddInput, today: string): Change & { id?: string } => {
  const found = locate(original)
  if ('error' in found) return { ok: false, error: `O roadmap tem erro e não foi alterado (${found.error}).` }
  const { roadmap: r, lines } = found
  const phaseId = typeof input.phase === 'number' ? String(input.phase) : text(input.phase)
  const phase = r.phases.find(p => p.id === phaseId)
  if (!phase) return { ok: false, error: `A fase ${JSON.stringify(input.phase)} não existe. Fases: ${r.phases.map(p => p.id).join(', ') || 'nenhuma'}.` }
  const title = text(input.title)
  if (!title) return { ok: false, error: 'Falta o "title" do item.' }
  const twin = r.items.find(i => i.phase === phase.id && slugify(i.title) === slugify(title))
  if (twin) return { ok: false, error: `Já existe esse item na ${phaseLabel(phase)}: "${twin.title}" (${twin.id}).` }
  const status = (input.status ?? 'todo') as ItemStatus
  if (!ITEM_STATUSES.includes(status)) return { ok: false, error: `Status ${JSON.stringify(input.status)} inválido: use done, doing, todo ou blocked.` }
  const deps = input.dependsOn === undefined ? [] : Array.isArray(input.dependsOn) ? input.dependsOn : [input.dependsOn]
  const depTitles: string[] = []
  for (const d of deps) {
    const dep = r.items.find(i => i.id === String(d))
    if (!dep) return { ok: false, error: `"dependsOn" cita ${JSON.stringify(d)}, que não existe. Use roadmap_status para ver os ids.` }
    depTitles.push(dep.title)
  }
  const after = text(input.after)
  if (after && !r.items.some(i => i.id === after)) return { ok: false, error: `"after" cita "${after}", que não é id de nenhum item.` }
  const line: Line = {
    indent: '',
    box: status === 'done' ? 'x' : ' ',
    title,
    owner: text(input.owner),
    status,
    waitingOn: text(input.waitingOn),
    after: depTitles.length > 0 ? depTitles.join(', ') : undefined,
    gate: input.gate === true,
    doneAt: status === 'done' ? today : undefined,
  }
  const at = after ? found.itemEnd.get(after)! + 1 : (found.phaseEnd.get(phase.id) ?? found.phaseLine.get(phase.id)!) + 1
  const added = [writeLine(line)]
  const notes = text(input.notes)
  if (notes) added.push(`  - ${notes}`)
  // Uma fase sem itens: o item entra depois de uma linha em branco, embaixo do título.
  if (!after && !r.items.some(i => i.phase === phase.id) && lines[at - 1]?.trim()) added.unshift('')
  lines.splice(at, 0, ...added)
  const id = (() => {
    const taken = new Set(r.items.map(i => i.id))
    let candidate = slugify(title)
    for (let n = 2; taken.has(candidate); n++) candidate = `${slugify(title)}-${n}`
    return candidate
  })()

  return { ok: true, text: join(lines, original), message: `Item criado na ${phaseLabel(phase)}: "${title}" (${id})`, title, id }
}
