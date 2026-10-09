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
  /** O gasto por modelo das últimas horas (`recent`) ou da janela toda. */
  mixBasis: 'recent' | 'window'
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

/** Uma sessão do Claude Code desta máquina, como ela mesma se registra. */
export type SessionRecord = {
  id: string
  project: string
  model?: string
  startedAt: number
  /** O último sinal da sessão (a cada minuto enquanto aberta). */
  updatedAt: number
  tokens: Totals
  /** Custo equivalente em preço de API, como o /cost soma. */
  costUsd: number
  ended?: boolean
}

export type SessionsView = {
  /** As abertas agora, esta primeiro. */
  running: SessionRecord[]
  total: { tokens: Totals; costUsd: number; count: number }
  /** Todas as de hoje, fechadas inclusive. */
  today: { tokens: Totals; costUsd: number; count: number }
}

/** O gasto dos créditos de API no ciclo, lido do relatório de custo do Console. */
export type ApiSpend = {
  cycleStart: number
  cycleEnd: number
  spentUsd: number
  creditUsd: number
  byModel: { model: string; usd: number }[]
  dailyUsd: number
  projectedUsd: number
  /** Quando o crédito acaba no ritmo atual, se for antes do fim do ciclo. */
  runsOutAt?: number
  fetchedAt: number
  problem?: string
}

export type Verdict = 'ok' | 'tight' | 'exhausts' | 'exhausted' | 'unknown'

export type WindowView = {
  kind: string
  label: string
  pct: number
  resetsAt?: number
  msToReset?: number
  /** % por hora usado na projeção. */
  ratePerHour?: number
  /**
   * De onde vem o ritmo: últimas horas (`recent`), média da janela (`window`)
   * ou, no semanal, o ritmo de trabalho medido pelo limite de 5h (`work`).
   */
  rateSource: 'recent' | 'window' | 'work' | 'none'
  /**
   * Horas de consumo até o reset no ritmo de `ratePerHour`: no 5h, o relógio;
   * no semanal por trabalho, as horas de trabalho que cabem até o reset.
   */
  hoursAhead?: number
  /** Horas de trabalho por dia usadas na projeção do semanal. */
  activeHoursPerDay?: number
  /**
   * Só no semanal: horas de uso que restam no ritmo da última hora de trabalho,
   * medido pelo limite de 5h. Informação extra; a projeção usa o ritmo da conta.
   */
  workHoursLeft?: number
  /** %/h de uso do semanal no ritmo da última hora de trabalho. */
  workRatePerHour?: number
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
  /** Quando os percentuais foram lidos de uma resposta da API. */
  readAt?: number
  /** A leitura veio de outra sessão desta máquina, mais recente que a desta. */
  isSharedReading?: boolean
  /** As sessões abertas nesta máquina e o total. */
  sessions?: SessionsView
  /** O id desta sessão, para marcá-la na lista. */
  selfId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'usage-limits': {
      snapshot: Snapshot | null
      session: Totals
      economy: boolean
      setup: Setup
      project: string
      api: ApiSpend | null
    }
  }
}
