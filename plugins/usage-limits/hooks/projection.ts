import type { ProjectBucket, ProjectShare, Totals, Verdict, WindowView } from '../types'

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export type Sample = { t: number; pct: number }

/** Amostras de uma janela, guardadas em $.store entre sessões. */
export type SampleLog = { resetsAt: number; points: Sample[] }

/** Tokens contados numa janela, guardados em $.store entre sessões. */
export type TokenBucket = { resetsAt: number; tokens: number; firstPct: number }

export type RawWindow = { kind: string; percentUsed: number; resetsAt?: string }

export const emptyTotals = (): Totals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
})

export const totalTokens = (t: Totals) =>
  t.input + t.output + t.cacheRead + t.cacheWrite

export const windowLength = (kind: string): number | undefined =>
  kind === 'five_hour' ? 5 * HOUR : kind.startsWith('seven_day') ? 7 * DAY : undefined

/** Quanto tempo de histórico vale como "ritmo atual". */
const recentLookback = (length: number) => (length <= 5 * HOUR ? HOUR : DAY)

/**
 * O menor período por onde dividir o uso. No semanal o ritmo é por dia: as
 * primeiras horas de trabalho não valem para as noites e pausas da semana.
 */
const minPeriod = (length: number) => (length <= 5 * HOUR ? 5 * MINUTE : DAY)

export const windowLabel = (kind: string): string => {
  if (kind === 'five_hour') return '5 horas'
  if (kind === 'seven_day') return 'Semanal'
  if (kind.startsWith('seven_day_')) return `Semanal (${kind.slice('seven_day_'.length)})`
  if (kind === 'spend_limit') return 'Gasto'
  return kind
}

export const shortLabel = (kind: string): string => {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'Sem'
  if (kind.startsWith('seven_day_')) return `Sem·${kind.slice('seven_day_'.length)}`
  return kind
}

/** Dois resets a menos de 10 min um do outro são a mesma janela. */
export const sameWindow = (a: number, b: number) => Math.abs(a - b) < 10 * MINUTE

/** Junta uma leitura ao log, reiniciando-o quando a janela virou. */
export const addSample = (
  log: SampleLog | undefined,
  resetsAt: number,
  sample: Sample,
): SampleLog => {
  const points = log && sameWindow(log.resetsAt, resetsAt) ? log.points : []
  const last = points[points.length - 1]
  if (last && last.pct === sample.pct) return { resetsAt, points }

  return { resetsAt, points: [...points, sample].slice(-500) }
}

/**
 * %/h nos últimos `lookback` ms: do valor que valia no começo do período até o
 * valor de agora. Parado, o ritmo cai para zero sozinho.
 */
export const recentRate = (
  points: Sample[],
  pctNow: number,
  now: number,
  lookback: number,
  floor = 0,
): number | undefined => {
  const from = now - lookback
  const before = [...points].reverse().find(p => p.t <= from)
  const start = before ? { t: from, pct: before.pct } : points[0]
  if (!start) return undefined
  const span = now - start.t
  if (span < Math.min(lookback / 4, 2 * HOUR)) return undefined

  return Math.max(0, ((pctNow - start.pct) / Math.max(span, floor)) * HOUR)
}

export const project = (
  raw: RawWindow,
  now: number,
  log?: SampleLog,
  bucket?: TokenBucket,
): WindowView => {
  const pct = raw.percentUsed
  const resetsAt = raw.resetsAt ? Date.parse(raw.resetsAt) : undefined
  const length = windowLength(raw.kind)
  const view: WindowView = {
    kind: raw.kind,
    label: windowLabel(raw.kind),
    pct,
    rateSource: 'none',
    verdict: 'unknown',
  }

  if (resetsAt === undefined || Number.isNaN(resetsAt)) return view
  view.resetsAt = resetsAt
  view.msToReset = Math.max(0, resetsAt - now)

  if (bucket && sameWindow(bucket.resetsAt, resetsAt)) {
    view.windowTokens = bucket.tokens
    const moved = pct - bucket.firstPct
    if (moved >= 1 && bucket.tokens > 0) view.tokensPerPct = bucket.tokens / moved
  }

  if (pct >= 100) {
    view.verdict = 'exhausted'
    return view
  }
  if (length === undefined) return view

  const elapsed = Math.max(minPeriod(length), now - (resetsAt - length))
  view.windowRatePerHour = (pct / elapsed) * HOUR

  const points = log && sameWindow(log.resetsAt, resetsAt) ? log.points : []
  view.recentRatePerHour = recentRate(points, pct, now, recentLookback(length), minPeriod(length))

  const rate = view.recentRatePerHour ?? view.windowRatePerHour
  view.rateSource = view.recentRatePerHour !== undefined ? 'recent' : 'window'
  view.ratePerHour = rate
  view.pctAtReset = pct + (rate * view.msToReset) / HOUR

  view.verdict = verdictOf(view.pctAtReset)
  if (rate > 0) view.hoursLeft = (100 - pct) / rate
  if (rate > 0 && view.pctAtReset >= 100) {
    view.exhaustAt = now + ((100 - pct) / rate) * HOUR
  }

  return view
}

const verdictOf = (pctAtReset: number): Verdict =>
  pctAtReset >= 100 ? 'exhausts' : pctAtReset >= 85 ? 'tight' : 'ok'

/** Divide o que a janela andou entre os projetos, pela fração do gasto de cada um. */
export const projectShares = (bucket: ProjectBucket | undefined, pct: number): ProjectShare[] => {
  if (!bucket) return []
  const total = Object.values(bucket.byProject).reduce((sum, n) => sum + n, 0)
  if (total <= 0) return []
  const moved = pct - bucket.firstPct

  return Object.entries(bucket.byProject)
    .map(([name, cost]) => ({
      name,
      share: cost / total,
      points: moved >= 1 ? (cost / total) * moved : undefined,
    }))
    .sort((a, b) => b.share - a.share)
}

/** Nome curto do projeto a partir da raiz do git ou da pasta da sessão. */
export const projectName = (dir: string): string => {
  const clean = dir.replace(/[\\/]+$/, '').replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')
  const parts = clean.split(/[\\/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? dir
  const generic = ['workdir', 'workspace', 'src', 'app', 'repo']

  return generic.includes(last.toLowerCase()) && parts.length > 1 ? (parts[parts.length - 2] ?? last) : last
}

// ---------- formatação ----------

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const pad = (n: number) => String(n).padStart(2, '0')

export const clockTime = (t: number, now: number): string => {
  const d = new Date(t)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = new Date(now).toDateString() === d.toDateString()

  return sameDay ? hm : `${WEEKDAYS[d.getDay()]} ${hm}`
}

export const duration = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / MINUTE))
  if (minutes < 60) return `${minutes}min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${pad(minutes % 60)}`
  const days = Math.floor(hours / 24)

  return `${days}d${hours % 24}h`
}

export const compact = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`

  return String(Math.round(n))
}

export const percent = (n: number) => `${Math.round(n)}%`

/** Horas em pt-BR: "2,3h" abaixo de 10, "52h" acima. */
export const hours = (h: number): string =>
  h < 10 ? `${h.toFixed(1).replace('.', ',')}h` : `${Math.round(h)}h`

export const usd = (n: number) => `US$ ${n.toFixed(2).replace('.', ',')}`

export const bar = (pct: number, width: number): string => {
  const full = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)

  return '█'.repeat(full) + '░'.repeat(width - full)
}

/**
 * O trecho de uma janela na linha de status: curto, porque o terminal corta a
 * linha; o reset e os detalhes ficam na faixa e no painel.
 */
export const statusPart = (w: WindowView): string => {
  const head = `${shortLabel(w.kind)} ${percent(w.pct)}`
  if (w.verdict === 'exhausted') {
    return `${head} ⛔ volta em ${hours((w.msToReset ?? 0) / HOUR)}`
  }
  if (w.ratePerHour === undefined) return head
  if (w.hoursLeft === undefined) return `${head} parado ✓`
  const mark = w.verdict === 'exhausts' ? '⚠' : w.verdict === 'tight' ? '△' : '✓'

  return `${head} dura ~${hours(w.hoursLeft)} ${mark}`
}

export const statusLine = (windows: WindowView[], session: Totals, costUsd: number | undefined) => {
  const parts = windows.map(statusPart)
  const usage = [`${compact(totalTokens(session))} tok`]
  if (costUsd !== undefined) usage.push(usd(costUsd))
  parts.push(usage.join(' · '))

  return parts.join(' │ ')
}
