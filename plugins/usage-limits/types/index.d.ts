export type Totals = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  turns: number
}

/** As quatro contagens de tokens de uma resposta. */
export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Tokens de uma janela por papel (principal ou subagente) e por modelo. */
export type Mix = {
  resetsAt: number
  main: Record<string, Tokens>
  sub: Record<string, Tokens>
}

/** O que a sessão está usando no fio principal. */
export type Setup = { mainModel?: string; mainEffort?: string }

export type ScenarioId = 'sub-haiku' | 'main-sonnet-sub-haiku' | 'all-sonnet' | 'all-haiku'

export type Scenario = {
  id: ScenarioId
  label: string
  /** Custo do cenário sobre o custo atual (0,4 = 60% mais barato). */
  factor: number
  hoursLeft?: number
  pctAtReset: number
  lasts: boolean
}

export type Advice = {
  windowKind: string
  windowLabel: string
  mainModel?: string
  mainEffort?: string
  /** Parte do gasto da janela feita por subagentes, 0 a 1. */
  subShare: number
  subModels: string[]
  scenarios: Scenario[]
  /** O cenário recomendado: o menos disruptivo que faz o limite durar. */
  pick?: ScenarioId
  /** true quando nada precisa mudar. */
  isFine: boolean
  headline: string
  tip?: string
}

/** A parte de um projeto no gasto de uma janela. */
export type ProjectShare = {
  name: string
  /** Fração do gasto da janela, 0 a 1. */
  share: number
  /** Pontos do limite atribuídos ao projeto, pela fração do gasto. */
  points?: number
}

/** Gasto em US$ (preço de API) por projeto numa janela. */
export type ProjectBucket = { resetsAt: number; firstPct: number; byProject: Record<string, number> }

export type Verdict = 'ok' | 'tight' | 'exhausts' | 'exhausted' | 'unknown'

export type WindowView = {
  kind: string
  label: string
  pct: number
  resetsAt?: number
  msToReset?: number
  /** % por hora usado na projeção. */
  ratePerHour?: number
  rateSource: 'recent' | 'window' | 'none'
  /** Média de %/h desde o início da janela. */
  windowRatePerHour?: number
  /** %/h na última hora (5h) ou nas últimas 24h (semanal). */
  recentRatePerHour?: number
  /** Horas até chegar a 100% no ritmo usado; ausente quando parado. */
  hoursLeft?: number
  /** Quando chega a 100% no ritmo usado, se antes do reset. */
  exhaustAt?: number
  /** % projetado no momento do reset. */
  pctAtReset?: number
  verdict: Verdict
  /** Tokens contados nesta janela (todas as sessões com o mod). */
  windowTokens?: number
  /** Tokens por 1% do limite, medido nesta janela. */
  tokensPerPct?: number
  /** Quanto cada projeto gastou nesta janela, nesta máquina. */
  projects?: ProjectShare[]
}

export type Snapshot = {
  updatedAt: number
  windows: WindowView[]
  costUsd?: number
  contextPercent?: number
  advice?: Advice
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': { snapshot: Snapshot | null; session: Totals; economy: boolean; setup: Setup; project: string }
  }
}
