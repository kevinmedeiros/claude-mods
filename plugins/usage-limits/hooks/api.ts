import type { ApiSpend } from '../types'
import { DAY } from './projection'

/** O ciclo dos créditos: começa no dia `day` de cada mês, à meia-noite local. */
export const cycleBounds = (now: number, day: number): { start: number; end: number } => {
  const d = new Date(now)
  const clamp = (year: number, month: number) => Math.min(Math.max(1, Math.round(day)), new Date(year, month + 1, 0).getDate())
  let start = new Date(d.getFullYear(), d.getMonth(), clamp(d.getFullYear(), d.getMonth()))
  if (start.getTime() > now) {
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1)
    start = new Date(prev.getFullYear(), prev.getMonth(), clamp(prev.getFullYear(), prev.getMonth()))
  }
  const after = new Date(start.getFullYear(), start.getMonth() + 1, 1)
  const end = new Date(after.getFullYear(), after.getMonth(), clamp(after.getFullYear(), after.getMonth()))

  return { start: start.getTime(), end: end.getTime() }
}

type CostReport = {
  data?: { starting_at?: string; results?: { amount?: string; model?: string | null; description?: string | null }[] }[]
  has_more?: boolean
  next_page?: string | null
}

/** Soma uma página do relatório de custo: total e por modelo, em US$. */
export const sumCostReport = (json: string): { usd: number; byModel: Record<string, number>; next?: string } => {
  const report = JSON.parse(json) as CostReport
  let cents = 0
  const byModel: Record<string, number> = {}
  for (const bucket of report.data ?? []) {
    for (const item of bucket.results ?? []) {
      const amount = Number(item.amount ?? 0)
      if (!Number.isFinite(amount)) continue
      cents += amount
      const model = item.model ?? (item.description?.split(' Usage')[0] || 'outros')
      byModel[model] = (byModel[model] ?? 0) + amount / 100
    }
  }

  return { usd: cents / 100, byModel, next: report.has_more && report.next_page ? report.next_page : undefined }
}

export const costReportUrl = (start: number, now: number, page?: string) => {
  // Os baldes são diários em UTC: pede do dia do início até o fim de hoje.
  const from = new Date(start)
  from.setUTCHours(0, 0, 0, 0)
  const to = new Date(now + DAY)
  to.setUTCHours(0, 0, 0, 0)
  const params = [
    `starting_at=${encodeURIComponent(from.toISOString())}`,
    `ending_at=${encodeURIComponent(to.toISOString())}`,
    'group_by[]=description',
    'limit=31',
  ]
  if (page) params.push(`page=${encodeURIComponent(page)}`)

  return `https://api.anthropic.com/v1/organizations/cost_report?${params.join('&')}`
}

/** Quanto do crédito foi gasto, o ritmo por dia e quando acaba nesse ritmo. */
export const projectApi = (
  spentUsd: number,
  byModel: Record<string, number>,
  bounds: { start: number; end: number },
  now: number,
  creditUsd: number,
): ApiSpend => {
  const elapsedDays = Math.max(1, (now - bounds.start) / DAY)
  const dailyUsd = spentUsd / elapsedDays
  const daysLeft = Math.max(0, (bounds.end - now) / DAY)
  const projectedUsd = spentUsd + dailyUsd * daysLeft
  const spend: ApiSpend = {
    cycleStart: bounds.start,
    cycleEnd: bounds.end,
    spentUsd,
    creditUsd,
    byModel: Object.entries(byModel)
      .map(([model, usd]) => ({ model, usd }))
      .filter(m => m.usd > 0)
      .sort((a, b) => b.usd - a.usd),
    dailyUsd,
    projectedUsd,
    fetchedAt: now,
  }
  if (dailyUsd > 0 && projectedUsd > creditUsd) {
    spend.runsOutAt = now + ((creditUsd - spentUsd) / dailyUsd) * DAY
  }

  return spend
}

/** O motivo de a chave não funcionar, em palavras. */
export const apiProblem = (status: number, text: string) => {
  if (status === 401 || status === 403) {
    return (
      'A chave não tem acesso ao relatório de custo. Ela precisa ser uma Admin API key (sk-ant-admin…) da ' +
      'organização ligada aos créditos; contas individuais do Console não têm Admin API (crie uma organização ' +
      'em Console > Settings > Organization).'
    )
  }
  if (status === 429) return 'O Console pediu para esperar; tento de novo em alguns minutos.'

  return `O Console respondeu ${status}: ${text.slice(0, 160)}`
}
