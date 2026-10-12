export type PhaseStatus = 'done' | 'doing' | 'todo'
export type ItemStatus = 'done' | 'doing' | 'todo' | 'blocked'

/** Uma fase do roadmap, como o mod a leu (ids sempre em texto, estado padrão "todo"). */
export type Phase = {
  id: string
  /** Vazio quando o arquivo não dá nome à fase. */
  name: string
  goal?: string
  status: PhaseStatus
  gate?: string
  gateStatus?: string
  notes?: string
}

/** Um item do roadmap, como o mod o leu. */
export type Item = {
  id: string
  phase: string
  title: string
  status: ItemStatus
  /** "Claude", o nome do usuário (o "owner" do arquivo) ou "both". */
  owner?: string
  waitingOn?: string
  dependsOn: string[]
  doneAt?: string
  evidence?: string
  area?: string
  gate: boolean
  notes?: string
}

export type Decision = { title: string; phase?: string; ref?: string }

/** O roadmap lido e conferido (formato versão 1). */
export type Roadmap = {
  version: number
  project?: string
  goal?: string
  updated?: string
  /** Quem é o usuário nos itens: os itens dele (ou "both") formam o "com você". */
  owner?: string
  phases: Phase[]
  items: Item[]
  path: string[]
  openDecisions: Decision[]
}

export type PhaseView = {
  phase: Phase
  done: number
  total: number
  /** Itens feitos sobre os itens da fase, arredondado para baixo (100 só com tudo feito). */
  pct: number
  isCurrent: boolean
}

/**
 * O que a faixa, o painel e as ferramentas mostram, calculado do roadmap. As listas
 * são da fase atual; as outras fases entram só como contagem.
 */
export type Summary = {
  current?: PhaseView
  phases: PhaseView[]
  /** Até 5, na ordem do caminho: não feitos, não bloqueados e com as dependências feitas. */
  next: Item[]
  /** Do usuário (ou de "both"), da fase atual, não feitos e livres: não bloqueados e com as dependências feitas. */
  mineNow: Item[]
  /** Do usuário (ou de "both"), da fase atual, não feitos: bloqueados ou esperando uma dependência. */
  mineLater: Item[]
  /** Quantos itens não feitos do usuário (ou de "both") há nas outras fases. */
  mineElsewhere: number
  /** Bloqueados da fase atual. */
  waiting: Item[]
  /** Quantos bloqueados há nas outras fases. */
  waitingElsewhere: number
  /** Decisões em aberto da fase atual e as sem fase. */
  decisions: Decision[]
  /** Quantas decisões em aberto são de outras fases. */
  decisionsElsewhere: number
  /** Itens feitos das fases que não são a atual, por fase. */
  doneElsewhere: { phase: Phase; count: number }[]
}

/** O arquivo do roadmap como o mod o leu por último. */
export type Board = {
  /** Caminho completo do arquivo. */
  path: string
  /** Como está na opção "file". */
  rel: string
  /** O nome da pasta do projeto. */
  project: string
  exists: boolean
  /** Quando o arquivo mudou por último (para notar edições feitas fora do mod). */
  mtimeMs: number
  /** Assinatura do texto: o "Ocultar" vale até ela mudar. */
  sig: string
  roadmap: Roadmap | null
  /** Linha e motivo, quando o arquivo não é um roadmap válido. */
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    roadmap: {
      board: Board | null
      /** Commits do projeto depois do último que mexeu no roadmap; null sem git. */
      stale: number | null
      /** A assinatura do roadmap quando a pessoa ocultou a faixa. */
      hidden: string | null
      /** O último aviso do mod. */
      notice: string | null
    }
  }
}
