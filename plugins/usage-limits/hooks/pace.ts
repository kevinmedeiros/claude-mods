import type { Mix, Tokens } from '../types'
import { HOUR, sameWindow } from './projection'
import type { RawWindow } from './projection'

/**
 * Quantos pontos do semanal custa cada ponto do limite de 5h, medido nas
 * mesmas respostas. O de 5h anda rápido; com essa razão, o ritmo semanal
 * passa a refletir a última hora de trabalho, não o dia inteiro.
 */
export type Calibration = {
  weekResetsAt: number
  sum5: number
  sumWeek: number
  last?: { p5: number; reset5: number; pWeek: number }
}

const resetOf = (w: RawWindow) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)

export const updateCalibration = (
  held: Calibration | undefined,
  five: RawWindow,
  week: RawWindow,
): Calibration | undefined => {
  const weekReset = resetOf(week)
  const reset5 = resetOf(five)
  if (Number.isNaN(weekReset) || Number.isNaN(reset5)) return held
  const c: Calibration =
    held && sameWindow(held.weekResetsAt, weekReset) ? { ...held } : { weekResetsAt: weekReset, sum5: 0, sumWeek: 0 }
  if (c.last) {
    // Uma janela de 5h nova começa do zero.
    const d5 = sameWindow(c.last.reset5, reset5) ? five.percentUsed - c.last.p5 : five.percentUsed
    const dWeek = week.percentUsed - c.last.pWeek
    if (d5 >= 0 && dWeek >= 0) {
      c.sum5 += d5
      c.sumWeek += dWeek
    }
  }
  c.last = { p5: five.percentUsed, reset5, pWeek: week.percentUsed }

  return c
}

/** Pontos do semanal por ponto do 5h; só com movimento suficiente para medir. */
export const weekPerFive = (c: Calibration | undefined) =>
  c && c.sum5 >= 6 && c.sumWeek > 0 ? c.sumWeek / c.sum5 : undefined

// ---------- horas de trabalho por dia ----------

/** As horas (índice `floor(t / 1h)`) em que houve resposta, dos últimos 14 dias. */
export const addActivity = (hours: number[] | undefined, now: number): number[] => {
  const h = Math.floor(now / HOUR)
  const list = hours ?? []
  if (list.includes(h)) return list

  return [...list, h].filter(x => x > h - 14 * 24).sort((a, b) => a - b)
}

/**
 * Horas de trabalho por dia. Com menos de 2 dias de histórico, supõe pelo menos
 * 8h por dia, para não tratar a primeira manhã como o ritmo da semana inteira.
 */
export const activeHoursPerDay = (hours: number[] | undefined, now: number): number => {
  const list = hours ?? []
  const nowH = Math.floor(now / HOUR)
  const first = list[0]
  // Dias de calendário cobertos pelo histórico, contando o primeiro dia inteiro.
  const days = first === undefined ? 0 : Math.ceil((nowH - first + 1) / 24)
  if (days < 2) return Math.max(8, list.filter(h => h > nowH - 24).length)
  const span = Math.min(7, days)
  const inSpan = list.filter(h => h > nowH - span * 24).length

  return Math.min(24, Math.max(1, inSpan / span))
}

// ---------- gasto recente por modelo ----------

export type HourlyMix = Record<string, { main: Record<string, Tokens>; sub: Record<string, Tokens> }>

const addTokens = (a: Tokens | undefined, b: Tokens): Tokens => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
})

/** Soma uma resposta ao balde da hora atual; guarda as últimas 72 horas. */
export const addHourly = (
  held: HourlyMix | undefined,
  now: number,
  role: 'main' | 'sub',
  modelKey: string,
  t: Tokens,
): HourlyMix => {
  const h = Math.floor(now / HOUR)
  const next: HourlyMix = {}
  for (const [k, v] of Object.entries(held ?? {})) if (Number(k) > h - 72) next[k] = v
  const bucket = next[h] ?? { main: {}, sub: {} }
  next[h] = { ...bucket, [role]: { ...bucket[role], [modelKey]: addTokens(bucket[role][modelKey], t) } }

  return next
}

/** O gasto das últimas `count` horas com resposta, dentro das últimas 12h. */
export const recentMix = (held: HourlyMix | undefined, now: number, resetsAt: number, count = 3): Mix | undefined => {
  const h = Math.floor(now / HOUR)
  const hours = Object.keys(held ?? {})
    .map(Number)
    .filter(k => k > h - 12)
    .sort((a, b) => b - a)
    .slice(0, count)
  if (hours.length === 0) return undefined
  const mix: Mix = { resetsAt, main: {}, sub: {} }
  for (const k of hours) {
    const bucket = held![k]!
    for (const role of ['main', 'sub'] as const) {
      for (const [model, t] of Object.entries(bucket[role])) mix[role][model] = addTokens(mix[role][model], t)
    }
  }

  return mix
}
