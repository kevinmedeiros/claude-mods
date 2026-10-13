export type PhaseStatus = 'done' | 'doing' | 'todo'
export type ItemStatus = 'done' | 'doing' | 'todo' | 'blocked'

/** Uma fase do roadmap, como o mod a leu (ids sempre em texto, estado padrão "todo"). */
export type Phase = {
  id: string
  /** Vazio quando o arquivo não dá nome à fase. */
  name: string
  /** Rótulo curto da fase na trilha (até 60; sem ele, o nome cortado em 18). */
  short?: string
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
  /** Rótulo curto do cartão (até 60; sem ele, o título cortado em 40). */
  short?: string
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

/** As colunas do quadro: Agora, Próximas, Esperando e Feito. */
export type ColumnId = 'doing' | 'next' | 'waiting' | 'done'

/** O filtro do quadro: tudo, ou só os itens do usuário (e os de "both"). */
export type Filter = 'all' | 'mine'

/** Quem faz o item: o usuário, o Claude, os dois ou outra pessoa. */
export type OwnerKind = 'me' | 'claude' | 'both' | 'other'

/** O layout do quadro pela largura: 4 colunas lado a lado, grade 2x2 ou empilhado. */
export type Layout = 'row' | 'grid' | 'stack'

/** Os itens de uma fase por estado. */
export type Counts = { done: number; doing: number; blocked: number; todo: number; total: number }

/** Um cartão do quadro. */
export type Card = {
  id: string
  /** O "short", ou o título cortado em 40. */
  label: string
  status: ItemStatus
  owner?: OwnerKind
  /** "você", "Claude", "os dois" ou o nome. */
  ownerText?: string
  gate: boolean
  /** Nos que esperam: o "waitingOn" do bloqueado (ou a primeira dependência aberta), ou a tarefa de que o item depende. */
  wait?: string
  /** "blocked": bloqueado; "dep": a fazer, esperando outra tarefa ficar pronta. */
  waitKind?: 'blocked' | 'dep'
  phase: string
  /** O item é de outra fase que não a atual (nas Próximas e no Agora). */
  isOtherPhase: boolean
}

export type KanbanColumn = {
  id: ColumnId
  title: string
  /** Quantos itens a coluna tem, com o filtro. */
  total: number
  cards: Card[]
  /** Quantos ficaram de fora (o "+N" abre mais 8 a cada clique). */
  more: number
  /** O "+N" já foi apertado: a coluna mostra o "menos". */
  isExpanded: boolean
}

/** O quadro como o painel o desenha. */
export type Kanban = {
  filter: Filter
  /** Itens do usuário em Agora, Próximas e Esperando (o "Comigo" do painel e da faixa). */
  mine: number
  layout: Layout
  /** Largura de cada coluna, em células. */
  columnWidth: number
  columns: KanbanColumn[]
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
      /** O filtro do quadro no painel. */
      filter: Filter
      /** Quantas vezes o "+N" de cada coluna foi apertado (8 cartões a mais por vez). */
      expanded: Partial<Record<ColumnId, number>>
      /** O id do item do cartão selecionado (o cartão abre no lugar, com o detalhe). */
      selected: string | null
      /** A lista de decisões do rodapé aberta. */
      decisions: boolean
      /** Quando o mod viu cada item virar feito (id → instante): a ordem da coluna Feito no mesmo dia. */
      doneSeen: Record<string, number>
    }
  }
}
