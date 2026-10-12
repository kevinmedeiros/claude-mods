import type { Decision, Item, ItemStatus, Phase, PhaseStatus, PhaseView, Roadmap, Summary } from '../types'

/**
 * O roadmap do projeto num JSON (formato versão 1, descrito no README do mod):
 *   { "version": 1, "project", "goal", "updated", "owner",
 *     "phases": [{ "id", "name", "status", ... }],
 *     "items": [{ "id", "phase", "title", "status", "owner", "dependsOn", ... }],
 *     "path": ["id", ...], "openDecisions": [{ "title", ... }] }
 * Aqui fica só lógica pura: ler e conferir, calcular o que mostrar e gravar mudanças.
 */

export const ITEM_STATUSES: readonly ItemStatus[] = ['done', 'doing', 'todo', 'blocked']
export const PHASE_STATUSES: readonly PhaseStatus[] = ['done', 'doing', 'todo']
export const NEXT_LIMIT = 5
/** Itens por lista no painel; o resto vira "e mais N". */
export const PANE_LIMIT = 6
/** Feitos da fase atual que o painel lista (os outros entram só na contagem). */
export const DONE_SHOWN = 3
/** Itens por lista no texto do roadmap_status, sem "all". */
export const TEXT_LIMIT = 8
/** Resultados de uma busca do roadmap_status. */
export const QUERY_LIMIT = 10
/** O título da próxima tarefa na faixa acima do prompt. */
export const BAND_TITLE_MAX = 55
/** As notas do item no pedido de "Fazer a próxima". */
const NOTES_MAX = 200

export const ITEM_LABEL: Record<ItemStatus, string> = {
  done: 'feito',
  doing: 'em andamento',
  todo: 'a fazer',
  blocked: 'bloqueado',
}
export const PHASE_LABEL: Record<PhaseStatus, string> = { done: 'feita', doing: 'em andamento', todo: 'a fazer' }
export const ITEM_MARK: Record<ItemStatus, string> = { done: '✓', doing: '▶', todo: '○', blocked: '‖' }

/** A ordem em que o mod escreve as chaves que ele mesmo cria; as que já existem ficam onde estão. */
const ROOT_KEYS = ['version', 'project', 'goal', 'updated', 'owner', 'phases', 'items', 'path', 'openDecisions']
const PHASE_KEYS = ['id', 'name', 'goal', 'status', 'gate', 'gateStatus', 'notes']
const ITEM_KEYS = ['id', 'phase', 'title', 'status', 'owner', 'waitingOn', 'dependsOn', 'doneAt', 'evidence', 'area', 'gate', 'notes']

// ---------- JSON: onde está cada valor e onde está o erro ----------

class ScanError {
  constructor(
    readonly offset: number,
    readonly message: string,
  ) {}
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

export type Scan = {
  /** Onde começa cada valor, pelo caminho: "", "/items", "/items/3", "/items/3/status". */
  at: Map<string, number>
  /** Onde cada valor acaba (o primeiro caractere depois dele). */
  end: Map<string, number>
  /** Onde começa o nome de cada campo de objeto (as aspas), pelo caminho do valor. */
  keyAt: Map<string, number>
  /** Os nomes dos campos de cada objeto, na ordem do texto. */
  keys: Map<string, string[]>
  error?: { offset: number; message: string }
}

/**
 * Percorre o JSON como o JSON.parse, guardando onde está cada valor e, num arquivo
 * inválido, onde está o primeiro erro e por quê (a mensagem do JSON.parse muda de
 * motor para motor e nem sempre diz a linha).
 */
export const scanJson = (text: string): Scan => {
  const at = new Map<string, number>()
  const end = new Map<string, number>()
  const keyAt = new Map<string, number>()
  const keys = new Map<string, string[]>()
  let i = 0
  let lastEnd = 0
  const err = (message: string, offset = i) => new ScanError(offset, message)

  const space = () => {
    while (i < text.length) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') i++
      else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) throw err('o JSON não aceita comentários')
      else break
    }
  }

  const string = (): string => {
    const start = i
    i++
    let out = ''
    for (;;) {
      const c = text[i]
      if (c === undefined || c === '\n' || c === '\r') throw err('aspas sem fechar', start)
      if (c === '"') {
        i++
        lastEnd = i
        return out
      }
      if (c < ' ') throw err('caractere de controle dentro de um texto')
      if (c === '\\') {
        const n = text[i + 1] ?? ''
        if (n === 'u') {
          const hex = text.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw err('escape \\u inválido')
          out += String.fromCharCode(Number.parseInt(hex, 16))
          i += 6
          continue
        }
        const esc = ESCAPES[n]
        if (esc === undefined) throw err(`escape inválido: \\${n}`)
        out += esc
        i += 2
        continue
      }
      out += c
      i++
    }
  }

  const value = (path: string): void => {
    space()
    at.set(path, i)
    one(path)
    end.set(path, lastEnd)
  }

  const one = (path: string): void => {
    const c = text[i]
    if (c === undefined) throw err('o arquivo acaba antes do fim do JSON')
    if (c === '{') return object(path)
    if (c === '[') return array(path)
    if (c === '"') {
      string()
      return
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      if (!m) throw err('número inválido')
      i += m[0].length
      lastEnd = i
      return
    }
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length
        lastEnd = i
        return
      }
    }
    if (c === "'") throw err('use aspas duplas (") em vez de simples')
    if (c === '}' || c === ']' || c === ',') throw err(`falta um valor antes de "${c}"`)
    throw err(/[A-Za-z_]/.test(c) ? 'texto sem aspas' : `caractere inesperado: ${c}`)
  }

  const object = (path: string) => {
    const open = i
    const names: string[] = []
    keys.set(path, names)
    i++
    space()
    if (text[i] === '}') {
      i++
      lastEnd = i
      return
    }
    let comma = -1
    for (;;) {
      space()
      const c = text[i]
      if (c === '}' && comma >= 0) throw err('vírgula sobrando antes de "}"', comma)
      if (c === undefined) throw err('falta fechar a chave "{" aberta aqui', open)
      if (c === "'") throw err('use aspas duplas (") em vez de simples')
      if (c !== '"') throw err('nome de campo sem aspas')
      const keyStart = i
      const key = string()
      names.push(key)
      keyAt.set(`${path}/${key}`, keyStart)
      space()
      if (text[i] !== ':') throw err(`falta ":" depois de "${key}"`)
      i++
      value(`${path}/${key}`)
      space()
      const d = text[i]
      if (d === ',') {
        comma = i
        i++
        continue
      }
      if (d === '}') {
        i++
        lastEnd = i
        return
      }
      if (d === undefined) throw err('falta fechar a chave "{" aberta aqui', open)
      throw err('falta uma vírgula depois deste valor', lastEnd)
    }
  }

  const array = (path: string) => {
    const open = i
    i++
    space()
    if (text[i] === ']') {
      i++
      lastEnd = i
      return
    }
    let comma = -1
    for (let n = 0; ; n++) {
      space()
      if (text[i] === ']' && comma >= 0) throw err('vírgula sobrando antes de "]"', comma)
      if (text[i] === undefined) throw err('falta fechar o colchete "[" aberto aqui', open)
      value(`${path}/${n}`)
      space()
      const d = text[i]
      if (d === ',') {
        comma = i
        i++
        continue
      }
      if (d === ']') {
        i++
        lastEnd = i
        return
      }
      if (d === undefined) throw err('falta fechar o colchete "[" aberto aqui', open)
      throw err('falta uma vírgula depois deste valor', lastEnd)
    }
  }

  try {
    value('')
    space()
    if (i < text.length) throw err('texto sobrando depois do fim do JSON')
  } catch (e) {
    if (e instanceof ScanError) return { at, end, keyAt, keys, error: { offset: e.offset, message: e.message } }
    throw e
  }

  return { at, end, keyAt, keys }
}

export const lineCol = (text: string, offset: number) => {
  const before = text.slice(0, offset)
  const line = before.split('\n').length

  return { line, column: offset - before.lastIndexOf('\n') }
}

// ---------- ler e conferir ----------

export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export type Parsed = { ok: true; roadmap: Roadmap } | { ok: false; error: string }

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Ids de fase e de item: texto, ou número escrito sem aspas. */
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' ? v.trim() || undefined : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined

const quote = (v: unknown) => JSON.stringify(v) ?? String(v)

/** Lê o texto do arquivo e confere o formato; o erro vem com a linha e o motivo. */
export const parseRoadmap = (raw: string): Parsed => {
  const text = stripBom(raw)
  if (!text.trim()) return { ok: false, error: 'o arquivo está vazio' }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (e) {
    const scan = scanJson(text)
    if (scan.error) {
      const { line, column } = lineCol(text, scan.error.offset)
      return { ok: false, error: `linha ${line}, coluna ${column}: ${scan.error.message}` }
    }
    return { ok: false, error: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` }
  }
  const scan = scanJson(text)
  const lineAt = (path: string): number => {
    for (let p = path; ; p = p.slice(0, p.lastIndexOf('/'))) {
      const offset = scan.at.get(p)
      if (offset !== undefined) return lineCol(text, offset).line
      if (!p) return 1
    }
  }

  return check(doc, lineAt)
}

const check = (doc: unknown, lineAt: (path: string) => number): Parsed => {
  const bad = (path: string, message: string): Parsed => ({ ok: false, error: `linha ${lineAt(path)}: ${message}` })
  if (!isObject(doc)) return bad('', 'o roadmap precisa ser um objeto JSON: { "version": 1, ... }')
  if (doc.version !== undefined && doc.version !== 1) {
    return bad('/version', `version ${quote(doc.version)} não suportada: este mod lê a versão 1`)
  }
  for (const key of ['project', 'goal', 'updated', 'owner']) {
    if (doc[key] !== undefined && typeof doc[key] !== 'string') return bad(`/${key}`, `"${key}" precisa ser um texto`)
  }
  for (const key of ['phases', 'items', 'path', 'openDecisions']) {
    if (doc[key] !== undefined && !Array.isArray(doc[key])) return bad(`/${key}`, `"${key}" precisa ser uma lista: [ ... ]`)
  }
  const list = (key: string) => (Array.isArray(doc[key]) ? (doc[key] as unknown[]) : [])
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

  const phases: Phase[] = []
  for (const [n, p] of list('phases').entries()) {
    const at = `/phases/${n}`
    if (!isObject(p)) return bad(at, `phases[${n}] precisa ser um objeto: { "id": ..., "name": ... }`)
    const id = idOf(p.id)
    if (!id) return bad(at, `phases[${n}]: falta o "id" da fase`)
    if (phases.some(q => q.id === id)) return bad(`${at}/id`, `fase "${id}" repetida`)
    const status = p.status ?? 'todo'
    if (!PHASE_STATUSES.includes(status as PhaseStatus)) {
      return bad(`${at}/status`, `fase "${id}": status ${quote(p.status)} inválido (use done, doing ou todo)`)
    }
    for (const key of ['name', 'goal', 'gate', 'gateStatus', 'notes']) {
      if (p[key] !== undefined && typeof p[key] !== 'string') return bad(`${at}/${key}`, `fase "${id}": "${key}" precisa ser um texto`)
    }
    phases.push({
      id,
      name: typeof p.name === 'string' ? p.name.trim() : '',
      goal: text(p.goal),
      status: status as PhaseStatus,
      gate: text(p.gate),
      gateStatus: text(p.gateStatus),
      notes: text(p.notes),
    })
  }

  const items: Item[] = []
  for (const [n, it] of list('items').entries()) {
    const at = `/items/${n}`
    if (!isObject(it)) return bad(at, `items[${n}] precisa ser um objeto: { "id": ..., "title": ... }`)
    const id = idOf(it.id)
    if (!id) return bad(at, `items[${n}]: falta o "id" do item`)
    if (items.some(q => q.id === id)) return bad(`${at}/id`, `item "${id}" repetido`)
    const phase = idOf(it.phase)
    if (!phase) return bad(at, `item "${id}": falta a "phase"`)
    if (!phases.some(p => p.id === phase)) return bad(`${at}/phase`, `item "${id}": a fase "${phase}" não existe em "phases"`)
    if (typeof it.title !== 'string' || !it.title.trim()) return bad(at, `item "${id}": falta o "title"`)
    const status = it.status ?? 'todo'
    if (!ITEM_STATUSES.includes(status as ItemStatus)) {
      return bad(`${at}/status`, `item "${id}": status ${quote(it.status)} inválido (use done, doing, todo ou blocked)`)
    }
    for (const key of ['owner', 'waitingOn', 'doneAt', 'evidence', 'area', 'notes']) {
      if (it[key] !== undefined && typeof it[key] !== 'string') return bad(`${at}/${key}`, `item "${id}": "${key}" precisa ser um texto`)
    }
    if (it.gate !== undefined && typeof it.gate !== 'boolean') return bad(`${at}/gate`, `item "${id}": "gate" precisa ser true ou false`)
    if (it.dependsOn !== undefined && !Array.isArray(it.dependsOn)) {
      return bad(`${at}/dependsOn`, `item "${id}": "dependsOn" precisa ser uma lista de ids`)
    }
    const dependsOn: string[] = []
    for (const [d, dep] of ((it.dependsOn as unknown[] | undefined) ?? []).entries()) {
      const depId = idOf(dep)
      if (!depId) return bad(`${at}/dependsOn/${d}`, `item "${id}": "dependsOn" precisa ser uma lista de ids`)
      dependsOn.push(depId)
    }
    items.push({
      id,
      phase,
      title: it.title.trim(),
      status: status as ItemStatus,
      owner: text(it.owner)?.trim(),
      waitingOn: text(it.waitingOn),
      dependsOn,
      doneAt: text(it.doneAt),
      evidence: text(it.evidence),
      area: text(it.area),
      gate: it.gate === true,
      notes: text(it.notes),
    })
  }
  const ids = new Set(items.map(i => i.id))
  for (const [n, it] of items.entries()) {
    for (const [d, dep] of it.dependsOn.entries()) {
      if (dep === it.id) return bad(`/items/${n}/dependsOn/${d}`, `item "${it.id}" depende de si mesmo`)
      if (!ids.has(dep)) return bad(`/items/${n}/dependsOn/${d}`, `item "${it.id}" depende de "${dep}", que não existe`)
    }
  }

  const path: string[] = []
  for (const [n, step] of list('path').entries()) {
    const id = idOf(step)
    if (!id || !ids.has(id)) return bad(`/path/${n}`, `"path" cita ${quote(step)}, que não é id de nenhum item`)
    if (!path.includes(id)) path.push(id)
  }

  const openDecisions: Decision[] = []
  for (const [n, d] of list('openDecisions').entries()) {
    if (typeof d === 'string' && d.trim()) {
      openDecisions.push({ title: d.trim() })
      continue
    }
    if (!isObject(d) || typeof d.title !== 'string' || !d.title.trim()) {
      return bad(`/openDecisions/${n}`, `openDecisions[${n}] precisa ter um "title"`)
    }
    openDecisions.push({ title: d.title.trim(), phase: idOf(d.phase), ref: text(d.ref) })
  }

  return {
    ok: true,
    roadmap: {
      version: 1,
      project: text(doc.project),
      goal: text(doc.goal),
      updated: text(doc.updated),
      owner: text(doc.owner)?.trim(),
      phases,
      items,
      path,
      openDecisions,
    },
  }
}

// ---------- calcular ----------

export const phaseLabel = (p: Phase) => `Fase ${p.id}${p.name ? ` ${p.name}` : ''}`

const lower = (s: string | undefined) => (s ?? '').trim().toLowerCase()

/** Corta o texto em `max` caracteres, com "…" no lugar do resto. */
export const cut = (text: string, max: number) => {
  const chars = Array.from(text)

  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`
}

/** O item é do usuário: o "owner" do item é o "owner" do arquivo, ou "both". */
export const isMine = (item: Item, r: Roadmap) => {
  const who = lower(item.owner)
  return who === 'both' || (who !== '' && who === lower(r.owner))
}

/** Quem faz, para mostrar: "você", "Claude", "você e Claude" ou o nome. */
export const ownerLabel = (item: Item, r: Roadmap): string | undefined => {
  const who = lower(item.owner)
  if (!who) return undefined
  if (who === 'both') return 'você e Claude'
  if (who === lower(r.owner)) return 'você'
  if (who === 'claude') return 'Claude'

  return item.owner
}

/** As dependências ainda não feitas de um item. */
export const pendingDeps = (item: Item, r: Roadmap): Item[] =>
  item.dependsOn.map(id => r.items.find(i => i.id === id)).filter((i): i is Item => i !== undefined && i.status !== 'done')

/** Dá para fazer agora: não feito, não bloqueado e com as dependências feitas. */
export const isFree = (item: Item, r: Roadmap) => item.status !== 'done' && item.status !== 'blocked' && pendingDeps(item, r).length === 0

export const phaseViews = (r: Roadmap): PhaseView[] => {
  const current = r.phases.find(p => p.status === 'doing') ?? r.phases.find(p => p.status !== 'done') ?? r.phases.at(-1)

  return r.phases.map(phase => {
    const items = r.items.filter(i => i.phase === phase.id)
    const done = items.filter(i => i.status === 'done').length
    const total = items.length
    const pct = total > 0 ? Math.floor((done * 100) / total) : phase.status === 'done' ? 100 : 0

    return { phase, done, total, pct, isCurrent: phase === current }
  })
}

/** O caminho: primeiro a ordem de "path", depois a ordem do arquivo. */
export const nextItems = (r: Roadmap, limit = NEXT_LIMIT): Item[] => {
  const done = new Set(r.items.filter(i => i.status === 'done').map(i => i.id))
  const rank = new Map<string, number>(r.path.map((id, n): [string, number] => [id, n]))

  return r.items
    .map((item, n) => ({ item, key: rank.get(item.id) ?? r.path.length + n }))
    .filter(({ item }) => item.status !== 'done' && item.status !== 'blocked' && item.dependsOn.every(d => done.has(d)))
    .sort((a, b) => a.key - b.key)
    .slice(0, limit)
    .map(x => x.item)
}

export const summarize = (r: Roadmap): Summary => {
  const phases = phaseViews(r)
  const current = phases.find(v => v.isCurrent)
  const here = (phase: string | undefined) => phase === current?.phase.id
  const notDone = r.items.filter(i => i.status !== 'done')
  const mine = notDone.filter(i => isMine(i, r))
  const blocked = notDone.filter(i => i.status === 'blocked')
  const decisionHere = (d: Decision) => d.phase === undefined || here(d.phase)

  return {
    current,
    phases,
    next: nextItems(r),
    mineNow: mine.filter(i => here(i.phase) && isFree(i, r)),
    mineLater: mine.filter(i => here(i.phase) && !isFree(i, r)),
    mineElsewhere: mine.filter(i => !here(i.phase)).length,
    waiting: blocked.filter(i => here(i.phase)),
    waitingElsewhere: blocked.filter(i => !here(i.phase)).length,
    decisions: r.openDecisions.filter(decisionHere),
    decisionsElsewhere: r.openDecisions.filter(d => !decisionHere(d)).length,
    doneElsewhere: phases
      .filter(v => !v.isCurrent && v.done > 0)
      .map(v => ({ phase: v.phase, count: v.done })),
  }
}

/** Os últimos feitos de uma fase: pela data, e sem data pela ordem do arquivo, do fim para o começo. */
export const recentDone = (r: Roadmap, phase: string, limit: number): Item[] =>
  r.items
    .map((item, n) => ({ item, n }))
    .filter(({ item }) => item.phase === phase && item.status === 'done')
    .sort((a, b) => (b.item.doneAt ?? '').localeCompare(a.item.doneAt ?? '') || b.n - a.n)
    .slice(0, limit)
    .map(x => x.item)

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/**
 * Os itens mais parecidos com a busca: o id exato primeiro, depois quem tem mais
 * palavras da busca no id ou no título (área, notas e espera valem menos); os não
 * feitos antes dos feitos; empate pela ordem do arquivo.
 */
export const searchItems = (r: Roadmap, query: string, limit = QUERY_LIMIT): { total: number; items: Item[] } => {
  const q = fold(query).trim()
  const parts = q.split(/[^a-z0-9]+/).filter(Boolean)
  const words = parts.filter(w => w.length >= 2).length > 0 ? parts.filter(w => w.length >= 2) : parts
  const scored = r.items
    .map((item, n) => {
      const main = fold(`${item.id} ${item.title}`)
      const extra = fold(`${item.area ?? ''} ${item.notes ?? ''} ${item.waitingOn ?? ''}`)
      let score = item.id.toLowerCase() === q ? 100 : 0
      for (const w of words) score += main.includes(w) ? 2 : extra.includes(w) ? 1 : 0
      return { item, n, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(a.item.status === 'done') - Number(b.item.status === 'done') || a.n - b.n)

  return { total: scored.length, items: scored.slice(0, limit).map(x => x.item) }
}

export const statusLine = (s: Summary): string | undefined =>
  s.current ? `Fase ${s.current.phase.id} · ${s.current.pct}%` : undefined

/** O aviso de desatualizado: só com git e acima do limite (0 desliga). */
export const staleText = (commits: number | null, limit: number): string | undefined =>
  commits !== null && limit > 0 && commits > limit ? `roadmap desatualizado: ${commits} commits sem atualizar` : undefined

/**
 * O pedido que os botões "Fazer a próxima" e "Pedir ao Claude" põem no prompt: um texto
 * para o item do Claude, um para o do usuário e um para o de "both", com as notas do item.
 */
export const startPrompt = (item: Item, r: Roadmap, withTool = true) => {
  const mark = (state: string) => `marque como ${state} no roadmap${withTool ? ' (roadmap_update)' : ''}`
  const task = `a tarefa "${item.title}" (${item.id}) do roadmap`
  const doing = item.status === 'doing'
  const notes = item.notes ? ` Notas do item: ${cut(item.notes, NOTES_MAX)}` : ''
  let text: string
  if (lower(item.owner) === 'both') {
    text = doing
      ? `Vamos continuar ${task}, que é minha e sua e já está em andamento: faça a sua parte e me diga, passo a passo, o que é comigo. Só ${mark('feita')}, com a evidência, quando as duas partes estiverem prontas.`
      : `Vamos fazer ${task}, que é minha e sua: ${mark('em andamento')} ao começar, faça a sua parte e me diga, passo a passo, o que é comigo. Só marque como feita, com a evidência, quando as duas partes estiverem prontas.`
  } else if (isMine(item, r)) {
    text = doing
      ? `Me ajude com ${task}, que é minha e já está em andamento: diga o que falta eu fazer, passo a passo. Quando eu disser que terminei, ${mark('feita')}, com a evidência.`
      : `Me ajude com ${task}, que é minha: diga o que eu preciso fazer, passo a passo. ${capital(mark('em andamento'))} agora e, quando eu disser que terminei, como feita, com a evidência.`
  } else {
    text = doing
      ? `Continue ${task}, que já está em andamento. Ao terminar, ${mark('feita')}, com a evidência do que foi feito.`
      : `Faça ${task}: ${mark('em andamento')} ao começar e, ao terminar, como feita, com a evidência do que foi feito.`
  }

  return text + notes
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export const textBar = (pct: number, width: number) => {
  const n = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(n) + '░'.repeat(width - n)
}

/** Barra de progresso em SVG, sem ids (várias convivem na mesma página). */
export const barSvg = (pct: number, width: number, color: string, height = 8) => {
  const fill = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width * 10) / 10
  const r = height / 2

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" rx="${r}" fill="#8a8f98" fill-opacity="0.25"/>`,
    fill > 0 ? `<rect width="${Math.max(fill, height)}" height="${height}" rx="${r}" fill="${color}"/>` : '',
    '</svg>',
  ].join('')
}

/** O que o Claude pode pedir ao roadmap_status além do resumo. */
export type StatusInput = { query?: unknown; phase?: unknown; all?: unknown }

/** Uma linha de item para o Claude: id, título, dono, estado, fase, espera e dependências. */
const itemText = (r: Roadmap, i: Item, details = false) => {
  const deps = pendingDeps(i, r)
  const extra = [
    ownerLabel(i, r),
    i.status === 'done' && i.doneAt ? `feito em ${i.doneAt}` : ITEM_LABEL[i.status],
    `fase ${i.phase}`,
    i.gate && 'gate',
    i.waitingOn && `espera: ${i.waitingOn}`,
    deps.length > 0 && `depende de: ${deps.map(d => d.id).join(', ')}`,
    details && i.evidence && `evidência: ${cut(i.evidence, 120)}`,
    details && i.notes && `notas: ${cut(i.notes, 160)}`,
  ].filter(Boolean)

  return `- [${i.id}] ${i.title} (${extra.join('; ')})`
}

const decisionText = (d: Decision) => `- ${d.title}${d.phase ? ` (fase ${d.phase})` : ''}${d.ref ? ` · ${d.ref}` : ''}`

/** Uma lista com título, cortada em `limit` com "e mais N". */
const listText = <T>(title: string, list: readonly T[], line: (x: T) => string, limit: number) => {
  if (list.length === 0) return undefined
  const shown = list.slice(0, limit).map(line)
  if (list.length > limit) shown.push(`- … e mais ${list.length - limit}`)

  return `${title} (${list.length}):\n${shown.join('\n')}`
}

const HINT =
  'Para achar o id de um item, chame roadmap_status com query (palavras do título). ' +
  'Com phase, ele lista uma fase inteira; com all: true, mostra tudo sem cortes.'

/**
 * O relatório em texto da ferramenta roadmap_status. Sem nada, o resumo da fase atual,
 * com listas curtas; com query, a busca; com phase, a fase; com all, tudo sem cortes.
 */
export const reportText = (r: Roadmap, file: string, warning?: string, input: StatusInput = {}) => {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query) return searchText(r, query)
  const phase = idOf(input.phase)
  if (phase !== undefined) return phaseText(r, phase, input.all === true)

  return summaryText(r, file, warning, input.all === true)
}

const summaryText = (r: Roadmap, file: string, warning: string | undefined, all: boolean) => {
  const s = summarize(r)
  const limit = all ? Number.POSITIVE_INFINITY : TEXT_LIMIT
  const line = (i: Item) => itemText(r, i)
  const who = `Com o usuário${r.owner ? ` (${r.owner})` : ''}`
  const out: (string | undefined)[] = []
  out.push(
    `Roadmap${r.project ? ` de ${r.project}` : ''}${r.goal ? ` (${r.goal})` : ''}${r.updated ? `, atualizado em ${r.updated}` : ''}. Arquivo: ${file}`,
  )
  if (s.current) {
    const c = s.current
    out.push(
      `Fase atual: ${phaseLabel(c.phase)} (${PHASE_LABEL[c.phase.status]}), ${c.pct}% (${c.done} de ${c.total} itens).` +
        (c.phase.gate ? ` Gate: ${c.phase.gate}${c.phase.gateStatus ? ` (${c.phase.gateStatus})` : ''}.` : ''),
    )
    out.push(`Fases: ${s.phases.map(v => `${v.phase.id} ${PHASE_LABEL[v.phase.status]} ${v.pct}%`).join(' · ')}`)
  } else {
    out.push('Nenhuma fase no roadmap.')
  }
  if (warning) out.push(`Aviso: ${warning}. Confira o que mudou (git log) e atualize os itens.`)
  out.push(s.next.length > 0 ? `Próximas:\n${s.next.map(line).join('\n')}` : 'Próximas: nenhuma livre agora.')

  if (all) {
    const notDone = r.items.filter(i => i.status !== 'done')
    out.push(listText(who, notDone.filter(i => isMine(i, r)), line, limit))
    out.push(listText('Esperando', notDone.filter(i => i.status === 'blocked'), line, limit))
    out.push(listText('Decisões em aberto', r.openDecisions, decisionText, limit))

    return out.filter(Boolean).join('\n')
  }

  out.push(listText(`${who}, livres agora`, s.mineNow, line, limit))
  out.push(listText(`${who}, depois (bloqueados ou esperando uma dependência)`, s.mineLater, line, limit))
  if (s.mineElsewhere > 0) out.push(`${who}, em outras fases: ${s.mineElsewhere}.`)
  out.push(listText('Esperando, na fase atual', s.waiting, line, limit))
  if (s.waitingElsewhere > 0) out.push(`Bloqueados em outras fases: ${s.waitingElsewhere}.`)
  out.push(listText('Decisões em aberto (fase atual e sem fase)', s.decisions, decisionText, limit))
  if (s.decisionsElsewhere > 0) out.push(`Decisões em aberto de outras fases: ${s.decisionsElsewhere}.`)
  out.push(HINT)

  return out.filter(Boolean).join('\n')
}

const searchText = (r: Roadmap, query: string) => {
  const { total, items } = searchItems(r, query)
  if (total === 0) {
    return `Nenhum item do roadmap tem "${query}". Tente outras palavras do título, ou chame roadmap_status com phase para listar uma fase.`
  }
  const head = `Itens do roadmap com "${query}": ${total}${total > items.length ? ` (os ${items.length} mais parecidos)` : ''}.`

  return [head, ...items.map(i => itemText(r, i, true))].join('\n')
}

const phaseText = (r: Roadmap, id: string, all: boolean) => {
  const v = phaseViews(r).find(p => p.phase.id === id)
  if (!v) return `A fase "${id}" não existe. Fases: ${r.phases.map(p => p.id).join(', ') || 'nenhuma'}.`
  const p = v.phase
  const items = r.items.filter(i => i.phase === id)
  const notDone = items.filter(i => i.status !== 'done')
  const done = items.filter(i => i.status === 'done')
  const decisions = r.openDecisions.filter(d => d.phase === id)
  const out: (string | undefined)[] = [
    `${phaseLabel(p)} (${PHASE_LABEL[p.status]}${v.isCurrent ? ', a atual' : ''}), ${v.pct}% (${v.done} de ${v.total} itens).` +
      (p.goal ? ` Objetivo: ${p.goal}.` : '') +
      (p.gate ? ` Gate: ${p.gate}${p.gateStatus ? ` (${p.gateStatus})` : ''}.` : ''),
  ]
  const line = (i: Item) => itemText(r, i)
  out.push(notDone.length > 0 ? listText('Não feitos', notDone, line, Number.POSITIVE_INFINITY) : 'Nada por fazer nesta fase.')
  if (done.length > 0) {
    out.push(all ? listText('Feitos', done, i => itemText(r, i, true), Number.POSITIVE_INFINITY) : `Feitos: ${done.length} (com all: true, a lista).`)
  }
  out.push(listText('Decisões em aberto', decisions, decisionText, Number.POSITIVE_INFINITY))

  return out.filter(Boolean).join('\n')
}

/** O modelo que o missingText mostra: JSON válido, no formato versão 1. */
export const TEMPLATE = [
  '{ "version": 1, "project": "Nome", "goal": "até o beta", "updated": "AAAA-MM-DD", "owner": "<nome do usuário>",',
  '  "phases": [',
  '    { "id": "1", "name": "Protótipo", "status": "doing", "gate": "o que precisa valer para fechar a fase" },',
  '    { "id": "2", "name": "Beta", "status": "todo" }',
  '  ],',
  '  "items": [',
  '    { "id": "primeiro-passo", "phase": "1", "title": "Primeiro passo", "status": "todo", "owner": "Claude" },',
  '    { "id": "conta-de-teste", "phase": "1", "title": "Criar a conta de teste", "status": "blocked", "owner": "<nome do usuário>", "waitingOn": "aprovação" },',
  '    { "id": "segundo-passo", "phase": "1", "title": "Segundo passo", "status": "todo", "owner": "both", "dependsOn": ["primeiro-passo"], "gate": true }',
  '  ],',
  '  "path": ["primeiro-passo", "segundo-passo"],',
  '  "openDecisions": [{ "title": "Uma decisão que falta tomar", "phase": "2" }] }',
].join('\n')

/** O que dizer quando o projeto ainda não tem roadmap: onde ele seria, um modelo e cada campo. */
export const missingText = (file: string) =>
  [
    `Não há roadmap neste projeto (procurei em ${file}). Para criar um, escreva esse arquivo em JSON, formato versão 1. Modelo:`,
    TEMPLATE,
    'Campos:',
    '- owner, na raiz: o nome do usuário. Os itens com esse mesmo owner (maiúsculas não importam) ou com "both" ficam "com você" no painel.',
    '- phases[]: id (único), name, goal, status (done, doing ou todo; a fase atual é a primeira "doing"), gate (o que precisa valer para fechar a fase), gateStatus, notes.',
    '- items[]: id (único, sem espaços), phase (id de uma fase), title (curto e acionável), status (done, doing, todo ou blocked), owner ("Claude", o mesmo owner da raiz ou "both").',
    '- items[], opcionais: dependsOn (ids dos itens que precisam estar feitos antes), waitingOn (junto de blocked: o que o item espera), ' +
      'doneAt (AAAA-MM-DD) e evidence (commit, arquivo, teste) nos feitos, area, gate (true se o item faz parte do gate da fase), notes.',
    '- path: ids dos itens na ordem em que devem ser feitos; os que ficam fora vêm depois, na ordem do arquivo.',
    '- openDecisions[]: title, phase, ref (onde a decisão é discutida).',
  ].join('\n')

// ---------- gravar ----------

export const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')

const INLINE_MAX = 80

/**
 * JSON com 2 espaços, como o JSON.stringify, mas listas curtas de valores simples
 * ficam numa linha só ("dependsOn": ["a", "b"]), para o arquivo seguir legível.
 * `indent` é a indentação da linha onde o valor começa e `used`, a coluna em que ele começa.
 */
export const formatJson = (value: unknown, eol = '\n', indent = '', used = 0): string => {
  const out = (v: unknown, indent: string, used: number): string => {
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]'
      if (v.every(x => x === null || typeof x !== 'object')) {
        const inline = `[${v.map(x => JSON.stringify(x) ?? 'null').join(', ')}]`
        if (used + inline.length + 1 <= INLINE_MAX) return inline
      }
      const inner = `${indent}  `

      return `[${eol}${v.map(x => inner + out(x, inner, inner.length)).join(`,${eol}`)}${eol}${indent}]`
    }
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function')
      if (entries.length === 0) return '{}'
      const inner = `${indent}  `

      return `{${eol}${entries
        .map(([k, x]) => {
          const head = `${inner}${JSON.stringify(k)}: `
          return head + out(x, inner, head.length)
        })
        .join(`,${eol}`)}${eol}${indent}}`
    }

    return JSON.stringify(v) ?? 'null'
  }

  return out(value, indent, used)
}

/** JSON numa linha só, com espaços como um arquivo escrito à mão: { "id": "a", "dependsOn": ["b"] }. */
export const inlineJson = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined && typeof x !== 'function')
    return entries.length === 0 ? '{}' : `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`).join(', ')} }`
  }

  return JSON.stringify(v) ?? 'null'
}

/** O texto novo com o fim de linha do original e, se o original tinha, a quebra no fim. */
const serialize = (doc: unknown, original: string) => {
  const eol = eolOf(original)
  const body = formatJson(doc, eol)

  return /\n$/.test(original) ? body + eol : body
}

// ---------- gravar só o que mudou ----------

/**
 * Uma mudança no texto, pelo caminho do scanJson: pôr um campo num objeto (trocando
 * o valor, ou criando o campo no lugar da ordem de referência), tirar um campo, ou
 * inserir um elemento numa lista.
 */
export type Op =
  | { op: 'set'; path: string; key: string; value: unknown; order: readonly string[] }
  | { op: 'delete'; path: string; key: string }
  | { op: 'insert'; path: string; index: number; value: unknown }

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1

/** A indentação da linha, se o que está em `offset` abre a linha; senão undefined (divide a linha com outra coisa). */
const ownLine = (text: string, offset: number): string | undefined => {
  const before = text.slice(lineStart(text, offset), offset)

  return /^[ \t]*$/.test(before) ? before : undefined
}

/** A indentação da linha onde está `offset`. */
const indentOf = (text: string, offset: number) => /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? ''

const isPlain = (v: unknown) => v === null || typeof v !== 'object'

const setKey = (text: string, scan: Scan, o: Extract<Op, { op: 'set' }>, eol: string): string | undefined => {
  const start = scan.at.get(o.path)
  const names = scan.keys.get(o.path)
  if (start === undefined || text[start] !== '{' || !names || new Set(names).size !== names.length) return undefined
  const member = (k: string) => `${o.path}/${k}`
  const name = JSON.stringify(o.key)

  if (names.includes(o.key)) {
    const from = scan.at.get(member(o.key))
    const to = scan.end.get(member(o.key))
    if (from === undefined || to === undefined) return undefined
    const old = text.slice(from, to)
    const body =
      isPlain(o.value) || !old.includes('\n')
        ? inlineJson(o.value)
        : formatJson(o.value, eol, indentOf(text, from), from - lineStart(text, from))

    return text.slice(0, from) + body + text.slice(to)
  }

  // Campo novo: depois do último que vem antes dele na ordem, ou antes do primeiro que vem depois (como o withKey).
  const pos = o.order.indexOf(o.key)
  let after = -1
  let before = -1
  names.forEach((k, n) => {
    const at = o.order.indexOf(k)
    if (at === -1 || pos === -1) return
    if (at < pos) after = n
    else if (before === -1) before = n
  })
  if (names.length === 0) return undefined
  if (after === -1 && before >= 0) {
    const keyStart = scan.keyAt.get(member(names[before]!))
    if (keyStart === undefined) return undefined
    const indent = ownLine(text, keyStart)
    const piece =
      indent === undefined
        ? `${name}: ${inlineJson(o.value)}, `
        : `${name}: ${formatJson(o.value, eol, indent, indent.length + name.length + 2)},${eol}${indent}`

    return text.slice(0, keyStart) + piece + text.slice(keyStart)
  }
  const ref = member(names[after >= 0 ? after : names.length - 1]!)
  const keyStart = scan.keyAt.get(ref)
  const valueEnd = scan.end.get(ref)
  if (keyStart === undefined || valueEnd === undefined) return undefined
  const indent = ownLine(text, keyStart)
  const piece =
    indent === undefined
      ? `, ${name}: ${inlineJson(o.value)}`
      : `,${eol}${indent}${name}: ${formatJson(o.value, eol, indent, indent.length + name.length + 2)}`

  return text.slice(0, valueEnd) + piece + text.slice(valueEnd)
}

const deleteKey = (text: string, scan: Scan, o: Extract<Op, { op: 'delete' }>): string | undefined => {
  const names = scan.keys.get(o.path)
  if (!names || new Set(names).size !== names.length) return undefined
  const n = names.indexOf(o.key)
  if (n === -1) return text
  if (names.length === 1) return undefined
  const member = (k: string) => `${o.path}/${k}`
  // Do nome do campo até o nome do seguinte; o último leva a vírgula de antes dele.
  const from = n < names.length - 1 ? scan.keyAt.get(member(o.key)) : scan.end.get(member(names[n - 1]!))
  const to = n < names.length - 1 ? scan.keyAt.get(member(names[n + 1]!)) : scan.end.get(member(o.key))
  if (from === undefined || to === undefined) return undefined

  return text.slice(0, from) + text.slice(to)
}

const insertAt = (text: string, scan: Scan, o: Extract<Op, { op: 'insert' }>, eol: string): string | undefined => {
  const start = scan.at.get(o.path)
  const end = scan.end.get(o.path)
  if (start === undefined || end === undefined || text[start] !== '[') return undefined
  let count = 0
  while (scan.at.has(`${o.path}/${count}`)) count++
  if (o.index < 0 || o.index > count) return undefined
  if (count === 0) return text.slice(0, start) + formatJson([o.value], eol, indentOf(text, start), start - lineStart(text, start)) + text.slice(end)

  // O elemento novo segue o vizinho: na linha dele, ou numa linha própria; numa linha só, se o vizinho é de uma linha só.
  const ref = `${o.path}/${o.index > 0 ? o.index - 1 : 0}`
  const from = scan.at.get(ref)
  const to = scan.end.get(ref)
  if (from === undefined || to === undefined) return undefined
  const indent = ownLine(text, from)
  const body = indent === undefined || !text.slice(from, to).includes('\n') ? inlineJson(o.value) : formatJson(o.value, eol, indent, indent.length)
  const sep = indent === undefined ? ', ' : `,${eol}${indent}`

  return o.index > 0 ? text.slice(0, to) + sep + body + text.slice(to) : text.slice(0, from) + body + sep + text.slice(from)
}

/** Aplica as mudanças ao texto, uma de cada vez; undefined se alguma não dá para fazer no lugar. */
export const patchText = (original: string, ops: readonly Op[]): string | undefined => {
  const eol = eolOf(original)
  let text = stripBom(original)
  for (const o of ops) {
    const scan = scanJson(text)
    if (scan.error) return undefined
    const next = o.op === 'set' ? setKey(text, scan, o, eol) : o.op === 'delete' ? deleteKey(text, scan, o) : insertAt(text, scan, o, eol)
    if (next === undefined) return undefined
    text = next
  }

  return text
}

/** Junta, ao mesmo tempo, a mudança no objeto (para conferir) e a mudança no texto (para gravar). */
class Edits {
  readonly ops: Op[] = []

  set(obj: Raw, path: string, key: string, value: unknown, order: readonly string[]): Raw {
    this.ops.push({ op: 'set', path, key, value, order })
    return withKey(obj, key, value, order)
  }

  delete(obj: Raw, path: string, key: string) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return
    this.ops.push({ op: 'delete', path, key })
    delete obj[key]
  }

  insert(list: unknown[], path: string, index: number, value: unknown) {
    this.ops.push({ op: 'insert', path, index, value })
    list.splice(index, 0, value)
  }
}

const put = (obj: Raw, key: string, value: unknown) => {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * Põe uma chave no objeto: se já existe, troca só o valor; se é nova, entra na
 * posição da ordem de referência (depois da última chave que vem antes dela).
 */
export const withKey = (obj: Raw, key: string, value: unknown, order: readonly string[]): Raw => {
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    put(obj, key, value)
    return obj
  }
  const pos = order.indexOf(key)
  const keys = Object.keys(obj)
  let after = -1
  let before = -1
  keys.forEach((k, n) => {
    const o = order.indexOf(k)
    if (o === -1 || pos === -1) return
    if (o < pos) after = n
    else if (before === -1) before = n
  })
  const at = after >= 0 ? after + 1 : before >= 0 ? before : keys.length
  const out: Raw = {}
  keys.forEach((k, n) => {
    if (n === at) put(out, key, value)
    put(out, k, obj[k])
  })
  if (at >= keys.length) put(out, key, value)

  return out
}

export type Change = { ok: true; text: string; message: string; title?: string } | { ok: false; error: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** "Traduzir os memos!" → "traduzir-os-memos". */
export const slugify = (title: string) => {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base.length <= 40) return base || 'item'
  const cut = base.slice(0, 41)
  const at = cut.lastIndexOf('-')

  return (at > 10 ? cut.slice(0, at) : base.slice(0, 40)).replace(/-+$/, '')
}

const uniqueId = (base: string, taken: Set<string>) => {
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++

  return `${base}-${n}`
}

const similar = (r: Roadmap, query: string) => {
  const words = slugify(query)
    .split('-')
    .filter(w => w.length >= 3)
  const hits = r.items.filter(i => words.some(w => i.id.includes(w) || slugify(i.title).includes(w))).slice(0, 5)

  return hits.length > 0 ? ` Ids parecidos: ${hits.map(i => i.id).join(', ')}.` : ' Use roadmap_status para ver os ids.'
}

const open = (original: string): { r: Roadmap; doc: Raw } | { error: string } => {
  const parsed = parseRoadmap(original)
  if (!parsed.ok) return { error: `O roadmap tem erro e não foi alterado (${parsed.error}). Corrija o arquivo antes.` }

  return { r: parsed.roadmap, doc: JSON.parse(stripBom(original)) as Raw }
}

/**
 * O texto a gravar: as mudanças feitas no lugar, se o resultado é o mesmo JSON que o
 * objeto mudado; senão (um objeto vazio, campo repetido), o arquivo inteiro no layout do mod.
 */
const finish = (doc: Raw, edits: Edits, original: string, today: string, message: string, title?: string): Change => {
  const full = edits.set(doc, '', 'updated', today, ROOT_KEYS)
  const expected = JSON.stringify(full)
  const patched = patchText(original, edits.ops)
  let same = false
  try {
    same = patched !== undefined && JSON.stringify(JSON.parse(patched)) === expected
  } catch {
    same = false
  }
  const text = same && patched !== undefined ? patched : serialize(full, original)
  const again = parseRoadmap(text)
  if (!again.ok) return { ok: false, error: `A mudança deixaria o roadmap inválido (${again.error}); nada foi gravado.` }

  return { ok: true, text, message, title }
}

const optionalText = (v: unknown, name: string): string | undefined | { error: string } => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') return { error: `"${name}" precisa ser um texto.` }

  return v.trim() || undefined
}

export type UpdateInput = {
  id?: unknown
  status?: unknown
  evidence?: unknown
  doneAt?: unknown
  note?: unknown
  waitingOn?: unknown
}

/**
 * Muda o estado de um item (ou de uma fase, se o id for de fase). "done" sem data
 * usa a de hoje; sair de "done" tira a data. Atualiza "updated". Nunca apaga item.
 */
export const applyUpdate = (original: string, input: UpdateInput, today: string): Change => {
  const opened = open(original)
  if ('error' in opened) return { ok: false, error: opened.error }
  const { r, doc } = opened
  const id = idOf(input.id)
  if (!id) return { ok: false, error: 'Falta o "id" do item.' }
  const fields = { evidence: optionalText(input.evidence, 'evidence'), note: optionalText(input.note, 'note'), waitingOn: optionalText(input.waitingOn, 'waitingOn') }
  for (const v of Object.values(fields)) if (typeof v === 'object') return { ok: false, error: v.error }
  const evidence = fields.evidence as string | undefined
  const note = fields.note as string | undefined
  const waitingOn = fields.waitingOn as string | undefined

  const n = r.items.findIndex(i => i.id === id)
  if (n === -1) {
    const k = r.phases.findIndex(p => p.id === id)
    if (k === -1) return { ok: false, error: `Não existe item "${id}" no roadmap.${similar(r, id)}` }
    const phase = r.phases[k]!
    const status = input.status ?? phase.status
    if (typeof status !== 'string' || !PHASE_STATUSES.includes(status as PhaseStatus)) {
      return { ok: false, error: `Status ${quote(input.status)} inválido para fase: use done, doing ou todo.` }
    }
    const phases = doc.phases as Raw[]
    const before = JSON.stringify(phases[k])
    const edits = new Edits()
    const at = `/phases/${k}`
    let obj = edits.set(phases[k]!, at, 'status', status, PHASE_KEYS)
    if (evidence) obj = edits.set(obj, at, 'gateStatus', evidence, PHASE_KEYS)
    if (note) obj = edits.set(obj, at, 'notes', phase.notes ? `${phase.notes} · ${note}` : note, PHASE_KEYS)
    if (JSON.stringify(obj) === before) return { ok: true, text: original, message: `${phaseLabel(phase)} já estava assim.` }
    phases[k] = obj

    return finish(doc, edits, original, today, `${phaseLabel(phase)} → ${PHASE_LABEL[status as PhaseStatus]}`, phaseLabel(phase))
  }

  const item = r.items[n]!
  const status = input.status ?? item.status
  if (typeof status !== 'string' || !ITEM_STATUSES.includes(status as ItemStatus)) {
    return { ok: false, error: `Status ${quote(input.status)} inválido: use done, doing, todo ou blocked.` }
  }
  if (input.doneAt !== undefined && (typeof input.doneAt !== 'string' || !DATE.test(input.doneAt))) {
    return { ok: false, error: `"doneAt" precisa ser uma data AAAA-MM-DD (recebi ${quote(input.doneAt)}).` }
  }
  const items = doc.items as Raw[]
  const before = JSON.stringify(items[n])
  const edits = new Edits()
  const at = `/items/${n}`
  let obj = edits.set(items[n]!, at, 'status', status, ITEM_KEYS)
  let doneAt: string | undefined
  if (status === 'done') {
    doneAt = (input.doneAt as string | undefined) ?? (item.status === 'done' && item.doneAt ? item.doneAt : today)
    obj = edits.set(obj, at, 'doneAt', doneAt, ITEM_KEYS)
  } else {
    edits.delete(obj, at, 'doneAt')
  }
  if (evidence) obj = edits.set(obj, at, 'evidence', evidence, ITEM_KEYS)
  if (waitingOn) obj = edits.set(obj, at, 'waitingOn', waitingOn, ITEM_KEYS)
  if (note) obj = edits.set(obj, at, 'notes', item.notes ? `${item.notes} · ${note}` : note, ITEM_KEYS)
  if (JSON.stringify(obj) === before) return { ok: true, text: original, message: `"${item.title}" já estava assim.`, title: item.title }
  items[n] = obj

  return finish(
    doc,
    edits,
    original,
    today,
    `"${item.title}" → ${ITEM_LABEL[status as ItemStatus]}${doneAt ? ` em ${doneAt}` : ''}`,
    item.title,
  )
}

export type AddInput = {
  phase?: unknown
  title?: unknown
  owner?: unknown
  after?: unknown
  status?: unknown
  dependsOn?: unknown
  waitingOn?: unknown
  area?: unknown
  gate?: unknown
  notes?: unknown
}

/**
 * Cria um item com id tirado do título (sem repetir id). Entra depois de "after"
 * (no arquivo e no caminho) ou no fim da sua fase. Recusa fase ou dependência que não existe.
 */
export const applyAdd = (original: string, input: AddInput, today: string): Change & { id?: string } => {
  const opened = open(original)
  if ('error' in opened) return { ok: false, error: opened.error }
  const { r, doc } = opened
  const phaseId = idOf(input.phase)
  const phase = r.phases.find(p => p.id === phaseId)
  if (!phase) {
    return { ok: false, error: `A fase ${quote(input.phase)} não existe. Fases: ${r.phases.map(p => p.id).join(', ') || 'nenhuma'}.` }
  }
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, error: 'Falta o "title" do item.' }
  const twin = r.items.find(i => i.phase === phase.id && slugify(i.title) === slugify(title))
  if (twin) return { ok: false, error: `Já existe esse item na ${phaseLabel(phase)}: "${twin.title}" (${twin.id}).` }
  const status = input.status ?? 'todo'
  if (typeof status !== 'string' || !ITEM_STATUSES.includes(status as ItemStatus)) {
    return { ok: false, error: `Status ${quote(input.status)} inválido: use done, doing, todo ou blocked.` }
  }
  const deps = input.dependsOn === undefined ? [] : Array.isArray(input.dependsOn) ? input.dependsOn : [input.dependsOn]
  const dependsOn: string[] = []
  for (const d of deps) {
    const depId = idOf(d)
    if (!depId || !r.items.some(i => i.id === depId)) return { ok: false, error: `"dependsOn" cita ${quote(d)}, que não existe.${similar(r, String(d))}` }
    dependsOn.push(depId)
  }
  const after = input.after === undefined || input.after === null || input.after === '' ? undefined : idOf(input.after)
  if (input.after !== undefined && input.after !== null && input.after !== '' && (!after || !r.items.some(i => i.id === after))) {
    return { ok: false, error: `"after" cita ${quote(input.after)}, que não é id de nenhum item.${similar(r, String(input.after))}` }
  }
  if (input.gate !== undefined && typeof input.gate !== 'boolean') return { ok: false, error: '"gate" precisa ser true ou false.' }
  const texts: Record<string, string | undefined> = {}
  for (const key of ['owner', 'waitingOn', 'area', 'notes'] as const) {
    const v = optionalText(input[key], key)
    if (typeof v === 'object') return { ok: false, error: v.error }
    texts[key] = v
  }

  const id = uniqueId(slugify(title), new Set(r.items.map(i => i.id)))
  const rawPhase = (doc.phases as Raw[]).find(p => idOf(p.id) === phase.id)
  const item: Raw = {}
  put(item, 'id', id)
  put(item, 'phase', rawPhase?.id ?? phase.id)
  put(item, 'title', title)
  put(item, 'status', status)
  if (texts.owner) put(item, 'owner', texts.owner)
  if (texts.waitingOn) put(item, 'waitingOn', texts.waitingOn)
  if (dependsOn.length > 0) put(item, 'dependsOn', dependsOn)
  if (status === 'done') put(item, 'doneAt', today)
  if (texts.area) put(item, 'area', texts.area)
  if (input.gate === true) put(item, 'gate', true)
  if (texts.notes) put(item, 'notes', texts.notes)

  // No arquivo: depois de "after", ou depois do último item da fase, ou antes do primeiro de uma fase seguinte.
  const order = r.phases.map(p => p.id)
  const rank = (phaseOf: string) => order.indexOf(phaseOf)
  const lastOfPhase = r.items.map(i => i.phase).lastIndexOf(phase.id)
  const firstLater = r.items.findIndex(i => rank(i.phase) > rank(phase.id))
  const at = after
    ? r.items.findIndex(i => i.id === after) + 1
    : lastOfPhase >= 0
      ? lastOfPhase + 1
      : firstLater >= 0
        ? firstLater
        : r.items.length
  const edits = new Edits()
  let next = doc
  if (Array.isArray(doc.items)) edits.insert(doc.items as unknown[], '/items', at, item)
  else next = edits.set(doc, '', 'items', [item], ROOT_KEYS)

  // No caminho: depois de "after" (se ele está no caminho), ou depois do último passo da mesma fase.
  if (r.path.length > 0 && Array.isArray(next.path)) {
    const phaseOfStep = (step: unknown) => r.items.find(i => i.id === idOf(step))?.phase ?? ''
    const steps = next.path as unknown[]
    const afterAt = after ? steps.findIndex(s => idOf(s) === after) : -1
    const samePhase = steps.map(phaseOfStep).lastIndexOf(phase.id)
    const laterAt = steps.findIndex(s => rank(phaseOfStep(s)) > rank(phase.id))
    const where = afterAt >= 0 ? afterAt + 1 : after ? -1 : samePhase >= 0 ? samePhase + 1 : laterAt >= 0 ? laterAt : steps.length
    if (where >= 0) edits.insert(steps, '/path', where, id)
  }

  const done = finish(next, edits, original, today, `Item criado na ${phaseLabel(phase)}: "${title}" (${id})`, title)

  return done.ok ? { ...done, id } : done
}

/** Assinatura curta do texto: muda quando o arquivo muda. */
export const hash = (text: string) => {
  let h = 5381
  for (let n = 0; n < text.length; n++) h = ((h * 33) ^ text.charCodeAt(n)) >>> 0

  return `${h.toString(36)}.${text.length}`
}
