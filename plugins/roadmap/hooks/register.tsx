import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Board, Card, ColumnId, Counts, Decision, Item, Kanban, KanbanColumn, Roadmap, Summary } from '../types'
import {
  CARD_STEP,
  DECISIONS_SHOWN,
  ITEM_LABEL,
  ITEM_MARK,
  applyAdd,
  applyUpdate,
  bandBar,
  cardLabel,
  countsText,
  currentPhase,
  cut,
  gateChip,
  hash,
  isStuck,
  itemLabel,
  kanban,
  mineCount,
  missingText,
  newlyDone,
  ownerChip,
  ownerKind,
  paneSvgWidth,
  parseRoadmap,
  pendingDeps,
  phaseCounts,
  phaseTitle,
  planBand,
  reportText,
  segBarSvg,
  splitBar,
  staleChip,
  staleCount,
  staleText,
  startPrompt,
  statusLine,
  summarize,
  trailAlt,
  trailSvg,
  trailText,
} from './roadmap'
import type { AddInput, Change, Seg, StatusInput, UpdateInput } from './roadmap'

const PANE = 'roadmap'

const board = atom({ plugin: 'roadmap', key: 'board' } as const, null)
const stale = atom({ plugin: 'roadmap', key: 'stale' } as const, null)
const hidden = atom({ plugin: 'roadmap', key: 'hidden' } as const, null)
const filtering = atom({ plugin: 'roadmap', key: 'filter' } as const, 'all')
const expanded = atom({ plugin: 'roadmap', key: 'expanded' } as const, {})
const selected = atom({ plugin: 'roadmap', key: 'selected' } as const, null)
const decisionsOpen = atom({ plugin: 'roadmap', key: 'decisions' } as const, false)
const doneSeen = atom({ plugin: 'roadmap', key: 'doneSeen' } as const, {})

/** Onde está o roadmap desta sessão. */
const where = { root: '', file: '', rel: '', project: '', hasGit: false, staleAt: 0 }

const isAbsolute = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p)
const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()

const today = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Relê o roadmap; `force` relê mesmo sem mudança na data do arquivo. Diz se mudou. */
const load = async ($: EngineInterface, force = false): Promise<boolean> => {
  if (!where.file) return false
  const held = await read($, board)
  let next: Board
  try {
    const exists = await $.fs.exists(where.file)
    const mtimeMs = exists ? (await $.fs.stat(where.file)).mtimeMs : 0
    if (!force && held && held.exists === exists && held.mtimeMs === mtimeMs) return false
    const text = exists ? await $.fs.read(where.file) : ''
    const parsed = exists ? parseRoadmap(text) : undefined
    next = {
      path: where.file,
      rel: where.rel,
      project: where.project,
      exists,
      mtimeMs,
      sig: exists ? hash(text) : '',
      roadmap: parsed?.ok ? parsed.roadmap : null,
      error: parsed && !parsed.ok ? parsed.error : null,
    }
  } catch {
    next = { path: where.file, rel: where.rel, project: where.project, exists: true, mtimeMs: 0, sig: 'erro', roadmap: null, error: 'não consegui ler o arquivo' }
  }
  if (held && JSON.stringify(held) === JSON.stringify(next)) return false
  // O que virou feito desde a última leitura: no mesmo dia, ele vem primeiro na coluna Feito.
  const fresh = held?.roadmap && next.roadmap ? newlyDone(held.roadmap, next.roadmap) : []
  if (fresh.length > 0) {
    const now = await $.clock.now()
    await update($, doneSeen, seen => ({ ...seen, ...Object.fromEntries(fresh.map((id, n) => [id, now + n / 1000])) }))
  }
  await update($, board, () => next)
  $.ui.status(!next.exists ? undefined : next.roadmap ? statusLine(summarize(next.roadmap)) : 'Roadmap com erro')

  return true
}

const git = ($: EngineInterface, args: string[]) => $.process.run(['git', ...args], { cwd: where.root, timeoutMs: 5000 })

/** Quantos commits o projeto tem depois do último que mexeu no roadmap (null sem git ou sem histórico). */
const refreshStale = async ($: EngineInterface) => {
  where.staleAt = await $.clock.now()
  let commits: number | null = null
  if (where.hasGit && where.file) {
    try {
      const log = await git($, ['log', '-1', '--format=%H', '--', where.rel])
      const last = log.exitCode === 0 ? log.stdout.trim() : ''
      if (last) {
        const count = await git($, ['rev-list', '--count', `${last}..HEAD`])
        const n = count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) : Number.NaN
        commits = Number.isFinite(n) ? n : null
        // Mexido e ainda não commitado: está sendo atualizado agora.
        if (commits !== null && commits > 0 && (await git($, ['diff', '--quiet', 'HEAD', '--', where.rel])).exitCode === 1) commits = 0
      }
    } catch {
      commits = null
    }
  }
  if ((await read($, stale)) !== commits) await update($, stale, () => commits)
}

type Answer = { deny: string } | { result: string }

/**
 * As gravações do mod, uma de cada vez: duas chamadas ao mesmo tempo (subagentes em
 * paralelo) partiriam do mesmo texto, e a segunda apagaria a primeira.
 */
let writing: Promise<unknown> = Promise.resolve()
const serial = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = writing.then(work)
  writing = run.catch(() => undefined)

  return run
}

const ATTEMPTS = 3

/**
 * Aplica uma mudança ao arquivo (só se o roadmap for válido) e avisa na tela. Relê o
 * arquivo dentro da fila e, se ele mudou por fora entre a leitura e a gravação (um
 * editor, o Edit do Claude), aplica de novo sobre o texto novo.
 */
const change = ($: EngineInterface, apply: (text: string, day: string) => Change, by: string): Promise<Answer> =>
  serial(async () => {
    if (!where.file || !(await $.fs.exists(where.file))) return { deny: missingText(where.rel) }
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const before = (await $.fs.stat(where.file)).mtimeMs
      const text = await $.fs.read(where.file)
      const result = apply(text, today(await $.clock.now()))
      if (!result.ok) return { deny: result.error }
      if (result.text === text) return { result: result.message }
      if ((await $.fs.stat(where.file)).mtimeMs !== before) continue
      await $.fs.write(where.file, result.text)
      await load($, true)
      await refreshStale($)
      $.ui.toast(`${by}: ${result.message}`, { timeoutMs: 6000 })

      return { result: result.message }
    }

    return { deny: 'O roadmap mudou por fora enquanto eu gravava (outro programa está mexendo nele); nada foi gravado. Tente de novo.' }
  })

const statusText = async ($: EngineInterface, limit: number, input: StatusInput) => {
  const b = await read($, board)
  if (!b?.exists) return missingText(where.rel)
  if (!b.roadmap) return `O roadmap (${b.rel}) tem erro: ${b.error}`

  return reportText(b.roadmap, b.rel, staleText(await read($, stale), limit), input)
}

/** "git commit", também com opções antes do subcomando (git -C pasta commit). */
const GIT_COMMIT = /\bgit(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+commit\b/

/**
 * O lembrete que vai para o Claude depois de um commit: o roadmap existe e o que
 * terminou se marca com roadmap_update. Nada quando o próprio commit (ou uma mudança
 * ainda não commitada) mexeu no roadmap.
 */
const commitNote = async ($: EngineInterface, limit: number): Promise<string | undefined> => {
  await load($)
  const b = await read($, board)
  if (!b?.roadmap) return undefined
  await refreshStale($)
  const commits = await read($, stale)
  if (commits === 0) return undefined
  const warning = staleText(commits, limit)

  return (
    `Este projeto tem roadmap (${b.rel}). Se este commit terminou um item, marque com roadmap_update e a evidência ` +
    `(o commit); o roadmap_status com query acha o id.${warning ? ` Aviso: ${warning}.` : ''}`
  )
}

// ---------- interface ----------

type BasicUi = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
/** As superfícies remotas desenham SVG; o terminal, glifos. */
type Ui = BasicUi & { Svg?: Elements['desktop']['Svg'] }
type Acts = { start: (item: Item) => () => void; view: () => void; hide: () => void; reload: () => void; create: () => void }
type View = { b: Board; r: Roadmap; s: Summary; commits?: number }

/** Os tons do desenho nas cores do tema. */
const TONE = { done: 'success', current: 'claude', doing: 'claude', todo: 'subtle' } as const
const OWNER_COLOR = { me: 'claude', claude: 'suggestion', both: 'merged' } as const
const STATUS_COLOR: Partial<Record<Item['status'], 'success' | 'claude' | 'inactive'>> = { done: 'success', doing: 'claude', blocked: 'inactive' }

/** Um pedaço de texto com o tom dele (o "dim" sai apagado). */
const seg = (ui: Ui, s: Seg) => {
  const { Text } = ui
  return s.tone === 'dim' ? <Text dimColor>{s.text}</Text> : <Text color={TONE[s.tone]} bold={s.tone === 'current'}>{s.text}</Text>
}

/** O chip do dono, colorido: "você" no destaque, "Claude", "os dois" ou o nome. */
const OwnerChip = (ui: Ui, item: Item | Card, r: Roadmap) => {
  const { Text } = ui
  const kind = 'label' in item ? item.owner : ownerKind(item, r)
  const text = 'label' in item ? item.ownerText : ownerChip(item, r)
  if (!kind || !text) return undefined

  return kind === 'other' ? <Text dimColor>{text}</Text> : <Text color={OWNER_COLOR[kind]}>{text}</Text>
}

/**
 * A faixa: uma linha. "Fase 2 ▰▰▰▱▱ 43%  › próxima (você)  comigo: 2  ⚠ …  [ Fazer ] [ Roadmap ] ocultar".
 * O rótulo da próxima fica inteiro: para caber, saem antes os chips, a barrinha, a moldura dos botões e o "Fase N".
 */
const Band = (ui: Ui, v: View, width: number, act: Acts, isTerminal: boolean) => {
  const { Box, Text, Button, Svg } = ui
  const { r, s } = v
  const first = s.next[0]
  const cur = s.current
  const isAllDone = r.items.length > 0 && r.items.every(i => i.status === 'done')
  const mine = mineCount(r)
  const head = cur ? `Fase ${cur.phase.id}` : 'Roadmap'
  const pct = cur ? `${cur.pct}%` : ''
  const owner = first ? ownerChip(first, r) : undefined
  const mineText = mine > 0 ? `comigo: ${mine}` : undefined
  const warn = v.commits !== undefined ? `⚠ ${staleChip(v.commits)}` : undefined
  const plan = planBand({
    width,
    head,
    pct,
    hasBar: !!cur,
    label: first ? itemLabel(first) : isAllDone ? 'tudo feito' : 'nada livre agora',
    hasNext: !!first,
    owner,
    mine: mineText,
    stale: warn,
    hide: isTerminal ? 'ocultar' : 'Ocultar',
  })
  const bar = cur && plan.bar ? bandBar(cur.pct) : undefined
  const counts = cur ? phaseCounts(r, cur.phase.id) : undefined
  const plain = plan.framed ? {} : ({ plain: true } as const)

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="nowrap">
      {plan.showHead ? (
        <Text bold color="claude">
          {head}
        </Text>
      ) : undefined}
      {bar && counts && Svg ? (
        <Svg source={segBarSvg(counts, 72)} alt={`${pct} da fase feito`} />
      ) : bar ? (
        <Text>
          <Text color="claude">{bar.full}</Text>
          <Text dimColor>{bar.empty}</Text>
        </Text>
      ) : undefined}
      <Text wrap="truncate-end">
        {pct ? <Text bold>{pct}</Text> : ''}
        {first ? (
          <Text>
            {'  › '}
            {plan.label}
            {plan.showOwner ? <Text dimColor> ({owner})</Text> : ''}
          </Text>
        ) : (
          <Text dimColor>
            {'  '}
            {plan.label}
          </Text>
        )}
        {plan.showMine ? <Text color="claude">{`  ${mineText}`}</Text> : ''}
        {plan.showStale ? <Text color="warning">{`  ${warn}`}</Text> : ''}
      </Text>
      {first ? <Button key="roadmap-go" label="Fazer" variant="primary" {...plain} onPress={act.start(first)} /> : undefined}
      <Button key="roadmap-view" label={plan.framed ? 'Roadmap' : 'Ver'} {...plain} onPress={act.view} />
      <Button key="roadmap-hide" label={isTerminal ? 'ocultar' : 'Ocultar'} plain dimColor role="dismiss" onPress={act.hide} />
    </Box>
  )
}

const ErrorBand = (ui: Ui, b: Board, width: number, act: Acts, isTerminal: boolean) => {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="nowrap">
      <Text color="error" wrap="truncate-end">
        ⚠ Roadmap com erro: {cut(b.error ?? '', Math.max(10, width - 40))}
      </Text>
      <Button key="roadmap-view" label="Roadmap" onPress={act.view} />
      <Button key="roadmap-hide" label={isTerminal ? 'ocultar' : 'Ocultar'} plain dimColor role="dismiss" onPress={act.hide} />
    </Box>
  )
}

/** A trilha das fases: um SVG que se ajusta à largura, ou glifos no terminal (os nós e o nome, em até duas linhas). */
const Trail = (ui: Ui, s: Summary, width: number) => {
  const { Box, Text, Svg } = ui
  if (s.phases.length === 0) return undefined
  // Sem width e height: a superfície usa a largura do próprio desenho, limitada ao espaço que há.
  if (Svg) return <Svg source={trailSvg(s.phases, paneSvgWidth(width))} alt={trailAlt(s.phases)} />
  const { nodes, labels } = trailText(s.phases, width)

  return (
    <Box key="trail" flexDirection="column">
      <Text wrap="truncate-end">{nodes.map(n => seg(ui, n))}</Text>
      {labels.map(line => (
        <Text wrap="truncate-end">{line.map(n => seg(ui, n))}</Text>
      ))}
    </Box>
  )
}

/** A barra da fase atual, segmentada: feito, em andamento e esperando (este mais claro, para a parte cheia bater com o %). */
const PhaseBar = (ui: Ui, c: Counts, width: number) => {
  const { Text, Svg } = ui
  if (Svg) {
    const px = Math.max(140, Math.min(480, paneSvgWidth(width) - 90))
    return <Svg source={segBarSvg(c, px, 10)} alt={`${c.done} de ${c.total} feitos · ${c.doing} em andamento · ${c.blocked} esperando`} />
  }
  const cells = splitBar(c, Math.max(10, Math.min(40, width - 12)))

  return (
    <Text>
      <Text color="success">{'█'.repeat(cells.done)}</Text>
      <Text color="claude">{'█'.repeat(cells.doing)}</Text>
      <Text color="inactive">{'▒'.repeat(cells.blocked)}</Text>
      <Text dimColor>{'░'.repeat(cells.rest)}</Text>
    </Text>
  )
}

/** O cartão da fase atual: título, chip do gate, barra com o % e contagens. */
const PhaseCard = (ui: Ui, v: View, width: number) => {
  const { Box, Text } = ui
  const cur = v.s.current
  if (!cur) {
    return (
      <Box key="phase" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text dimColor>Roadmap sem fases</Text>
      </Box>
    )
  }
  const c = phaseCounts(v.r, cur.phase.id)
  const [done, doing, blocked, todo] = countsText(c).split('  ')
  const gate = gateChip(cur.phase, width < 60)

  return (
    <Box key="phase" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" justifyContent="space-between">
        <Text bold>{phaseTitle(cur.phase)}</Text>
        {gate ? (
          <Text color="warning" wrap="truncate-end">
            ⚑ {gate}
          </Text>
        ) : undefined}
      </Box>
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {PhaseBar(ui, c, width)}
        <Text bold color="claude">
          {`${cur.pct}%`}
        </Text>
      </Box>
      <Text>
        <Text color="success">{done}</Text>
        {'  '}
        <Text color="claude">{doing}</Text>
        {'  '}
        <Text color="inactive">{blocked}</Text>
        {'  '}
        <Text dimColor>{todo}</Text>
      </Text>
    </Box>
  )
}

type BoardActs = {
  select: (id: string) => () => void
  more: (column: ColumnId) => () => void
  less: (column: ColumnId) => () => void
  filter: (to: 'all' | 'mine') => () => void
  start: (item: Item) => () => void
  close: () => void
}

const BORDER: Record<Card['status'], { style: string; color: 'claude' | 'subtle' | 'inactive' | 'success' }> = {
  doing: { style: 'round', color: 'claude' },
  todo: { style: 'round', color: 'subtle' },
  blocked: { style: 'dashed', color: 'inactive' },
  done: { style: 'round', color: 'success' },
}

/**
 * O detalhe de um item: o título inteiro (se o rótulo é outro), estado, dono, espera,
 * dependências abertas, data e evidência, notas e os botões. Dentro do cartão aberto,
 * ou numa caixa própria quando o cartão não está à vista.
 */
const Detail = (ui: Ui, item: Item, r: Roadmap, act: BoardActs, isBoxed: boolean) => {
  const { Box, Text, Button } = ui
  const deps = pendingDeps(item, r)
  const done = item.status === 'done'
  const owner = OwnerChip(ui, item, r)
  const color = STATUS_COLOR[item.status]
  const mark = `${ITEM_MARK[item.status]} ${ITEM_LABEL[item.status]}`
  const facts = [item.doneAt && `feito em ${item.doneAt}`, item.evidence && cut(item.evidence, 80)].filter(Boolean).join(' · ')
  // Dentro do cartão, o rótulo já aparece. Com "short", vai do título só o que ele acrescenta;
  // sem "short", o cartão aberto já mostra o título inteiro no lugar do rótulo.
  const short = item.short
  const more = !short || item.title === short ? '' : item.title.startsWith(short) ? item.title.slice(short.length).replace(/^[\s:;,.–—-]+/, '') : item.title

  const state = (
    <Text key="detail-state">
      {color ? <Text color={color}>{mark}</Text> : <Text>{mark}</Text>}
      {owner ? ['  ', owner] : ''}
      {isBoxed || item.phase !== currentPhase(r) ? <Text dimColor>{`  Fase ${item.phase}`}</Text> : ''}
      {item.gate ? <Text color="warning">{'  Gate'}</Text> : ''}
    </Text>
  )

  // Avulso, o título vem inteiro em cima; dentro do cartão, o estado primeiro e o título
  // (só se for diferente do rótulo) e as notas cortados, para o cartão não crescer demais.
  return (
    <Box key="detail" flexDirection="column" {...(isBoxed ? { borderStyle: 'round', borderColor: 'claude', paddingX: 1 } : {})}>
      {isBoxed ? <Text bold>{item.title}</Text> : state}
      {isBoxed ? state : more ? <Text>{cut(more, 120)}</Text> : undefined}
      {item.waitingOn && !done ? <Text>espera: {cut(item.waitingOn, 80)}</Text> : undefined}
      {deps.length > 0 ? <Text>depois de: {deps.map(itemLabel).join(', ')}</Text> : undefined}
      {done && facts ? <Text dimColor>{facts}</Text> : undefined}
      {item.notes ? <Text dimColor>{cut(item.notes, isBoxed ? 160 : 100)}</Text> : undefined}
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {!done ? <Button key="detail-start" label={isStuck(item, r) ? 'Ver o que falta' : 'Fazer agora'} variant="primary" onPress={act.start(item)} /> : undefined}
        <Button key="detail-close" label="Fechar" onPress={act.close} />
      </Box>
    </Box>
  )
}

/**
 * Um cartão: o rótulo (clicar abre e fecha) e, embaixo, o dono, o gate e a fase; nos que
 * esperam, o que esperam. Aberto, o cartão mostra o detalhe ali mesmo, com borda grossa.
 */
const CardView = (ui: Ui, card: Card, r: Roadmap, inner: number, sel: string | null, act: BoardActs) => {
  const { Box, Text, Button } = ui
  const done = card.status === 'done'
  // Quem espera (bloqueado, ou a fazer à espera de outra tarefa) tem a borda tracejada.
  const border = card.waitKind ? BORDER.blocked : BORDER[card.status]
  const item = card.id === sel ? r.items.find(i => i.id === card.id) : undefined
  const chips = [
    OwnerChip(ui, card, r),
    card.gate ? <Text color="warning">Gate</Text> : undefined,
    card.isOtherPhase ? <Text dimColor>Fase {card.phase}</Text> : undefined,
  ].filter(c => c !== undefined)
  const line2 = item ? (
    Detail(ui, item, r, act, false)
  ) : card.wait ? (
    <Text dimColor>{cardLabel(`${card.waitKind === 'dep' ? 'depois de' : '‖'} ${card.wait}`, inner)}</Text>
  ) : !done && chips.length > 0 ? (
    <Text wrap="truncate-end">{chips.flatMap((c, n) => (n === 0 ? [c] : ['  ', c]))}</Text>
  ) : undefined

  return (
    <Box
      key={`box-${card.id}`}
      flexDirection="column"
      borderStyle={item ? 'bold' : border.style}
      borderColor={item ? 'claude' : border.color}
      {...(done && !item ? { borderDimColor: true } : {})}
      paddingX={1}
    >
      <Button
        key={`card-${card.id}`}
        label={item && !item.short ? cardLabel(cut(item.title, 160), inner, 4) : cardLabel(card.label, inner)}
        plain
        {...(done && !item ? { dimColor: true } : {})}
        onPress={act.select(card.id)}
      />
      {line2}
    </Box>
  )
}

const HEADER_COLOR: Partial<Record<ColumnId, 'claude' | 'inactive' | 'success'>> = { doing: 'claude', waiting: 'inactive', done: 'success' }

/** Uma coluna: o nome e o contador, os cartões, o "+8 de N" (abre mais 8) e o "menos". */
const ColumnView = (ui: Ui, col: KanbanColumn, width: number, r: Roadmap, sel: string | null, act: BoardActs) => {
  const { Box, Text, Button } = ui
  const color = HEADER_COLOR[col.id]

  return (
    <Box key={`col-${col.id}`} flexDirection="column" width={width}>
      <Text>
        {color ? (
          <Text bold color={color}>
            {col.title}
          </Text>
        ) : (
          <Text bold>{col.title}</Text>
        )}{' '}
        <Text dimColor>{String(col.total)}</Text>
      </Text>
      {col.cards.length === 0 ? <Text dimColor>—</Text> : undefined}
      {col.cards.map(card => CardView(ui, card, r, Math.max(6, width - 4), sel, act))}
      {col.more > 0 || col.isExpanded ? (
        <Box flexDirection="row" columnGap={2}>
          {col.more > 0 ? (
            <Button key={`more-${col.id}`} label={col.more > CARD_STEP ? `+${CARD_STEP} de ${col.more}` : `+${col.more}`} plain dimColor onPress={act.more(col.id)} />
          ) : undefined}
          {col.isExpanded ? <Button key={`less-${col.id}`} label="menos" plain dimColor onPress={act.less(col.id)} /> : undefined}
        </Box>
      ) : undefined}
    </Box>
  )
}

/** O quadro: 4 colunas lado a lado, grade 2x2 ou empilhado (com Feito numa linha só). */
const BoardView = (ui: Ui, kb: Kanban, r: Roadmap, sel: string | null, act: BoardActs) => {
  const { Box, Text } = ui
  const [doing, next, waiting, done] = kb.columns as [KanbanColumn, KanbanColumn, KanbanColumn, KanbanColumn]
  const col = (c: KanbanColumn) => ColumnView(ui, c, kb.columnWidth, r, sel, act)
  if (kb.layout === 'row') {
    return (
      <Box key="board" flexDirection="row" columnGap={1}>
        {kb.columns.map(col)}
      </Box>
    )
  }
  if (kb.layout === 'grid') {
    return (
      <Box key="board" flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1}>
          {col(doing)}
          {col(next)}
        </Box>
        <Box flexDirection="row" columnGap={1}>
          {col(waiting)}
          {col(done)}
        </Box>
      </Box>
    )
  }

  return (
    <Box key="board" flexDirection="column" rowGap={1}>
      {col(doing)}
      {col(next)}
      {col(waiting)}
      <Text>
        <Text bold color="success">
          ✓ {done.title}
        </Text>{' '}
        <Text dimColor>{String(done.total)}</Text>
      </Text>
    </Box>
  )
}

/** O rodapé: o chip das decisões (abre uma lista curta) e o aviso de desatualizado. */
const Footer = (ui: Ui, decisions: Decision[], isOpen: boolean, commits: number | undefined, onToggle: () => void) => {
  const { Box, Text, Button } = ui
  if (decisions.length === 0 && commits === undefined) return undefined

  return (
    <Box key="footer" flexDirection="column">
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
        {decisions.length > 0 ? <Button key="decisions" label={`Decisões ${decisions.length}`} onPress={onToggle} /> : undefined}
        {commits !== undefined ? <Text color="warning">⚠ {staleChip(commits)}</Text> : undefined}
      </Box>
      {isOpen
        ? decisions.slice(0, DECISIONS_SHOWN).map(d => (
            <Text dimColor wrap="truncate-end">
              • {cut(d.title, 70)}
            </Text>
          ))
        : undefined}
    </Box>
  )
}

type PaneState = { kb: Kanban; sel: string | null; isDecisionsOpen: boolean }

/** O cartão do item está à vista no quadro (no empilhado, a coluna Feito é só uma contagem). */
const isOnBoard = (kb: Kanban, id: string) => kb.columns.some(c => (kb.layout !== 'stack' || c.id !== 'done') && c.cards.some(k => k.id === id))

/**
 * O painel /roadmap: trilha, fase atual, filtro, quadro e rodapé. Sem listas de texto. O
 * cartão escolhido abre no lugar; se ele não está à vista, o detalhe vem acima do quadro.
 */
const PaneView = (ui: Ui, v: View, width: number, st: PaneState, act: Acts, boardAct: BoardActs, onDecisions: () => void) => {
  const { Box, Text, Button } = ui
  const { b, r, s, commits } = v
  const item = st.sel ? r.items.find(i => i.id === st.sel) : undefined
  const chip = (key: string, label: string, on: boolean, onPress: () => void) => (
    <Button key={key} label={label} {...(on ? { variant: 'primary' as const } : { dimColor: true })} onPress={onPress} />
  )

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" columnGap={2} justifyContent="space-between">
        <Text bold>{r.project ?? b.project}</Text>
        <Button key="roadmap-reload" label="↻" plain onPress={act.reload} />
      </Box>
      {Trail(ui, s, width)}
      {PhaseCard(ui, v, width)}
      <Box key="filters" flexDirection="row" columnGap={1}>
        {chip('filter-all', 'Tudo', st.kb.filter === 'all', boardAct.filter('all'))}
        {chip('filter-mine', `Comigo ${st.kb.mine}`, st.kb.filter === 'mine', boardAct.filter('mine'))}
      </Box>
      {item && !isOnBoard(st.kb, item.id) ? Detail(ui, item, r, boardAct, true) : undefined}
      {BoardView(ui, st.kb, r, item ? item.id : null, boardAct)}
      {Footer(ui, s.decisions, st.isDecisionsOpen, commits, onDecisions)}
    </Box>
  )
}

/** O painel quando não há roadmap, ou quando o arquivo tem erro: um cartão curto. */
const EmptyPane = (ui: Ui, b: Board | null, act: Acts) => {
  const { Box, Text, Button } = ui
  const rel = b?.rel ?? where.rel

  if (b?.exists) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
        <Box flexDirection="row" columnGap={2} justifyContent="space-between">
          <Text bold color="error">
            ⚠ Roadmap com erro
          </Text>
          <Button key="roadmap-reload" label="↻" plain onPress={act.reload} />
        </Box>
        <Text>{b.error}</Text>
        <Text dimColor>{rel}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} rowGap={1}>
      <Text>
        <Text bold>Sem roadmap</Text>
        <Text dimColor> · {rel}</Text>
      </Text>
      <Box>
        <Button key="roadmap-create" label="Pedir ao Claude para criar" variant="primary" onPress={act.create} />
      </Box>
    </Box>
  )
}

const reload = async ($: EngineInterface) => {
  await load($, true)
  await refreshStale($)
}

/** Põe o pedido no prompt, sem enviar; sem caixa de prompt (um diálogo aberto), não faz nada. */
const fill = async ($: EngineInterface, text: string) => {
  try {
    await $.prompt.fill({ text })
  } catch {
    // Nada a fazer: a pessoa pode clicar de novo.
  }
}

const CREATE =
  'no formato versão 1 do mod roadmap (a ferramenta roadmap_status mostra o modelo e o que cada campo quer dizer). ' +
  'Monte as fases e os itens a partir do que já existe no projeto (README, docs, tarefas), com um "short" de até 40 caracteres ' +
  'em cada item de título longo (é o rótulo do cartão no quadro) e de até 18 em cada fase (o nome na trilha), e me mostre antes de gravar.'

/** O que os botões fazem; `withTool` diz se o pedido cita a ferramenta roadmap_update. */
const acts = ($: EngineInterface, b: Board | null, withTool: boolean): Acts => ({
  start: item => () => {
    if (b?.roadmap) void fill($, startPrompt(item, b.roadmap, withTool))
  },
  view: () => void $.ui.open({ id: PANE, title: 'Roadmap' }).catch(() => undefined),
  hide: () => void update($, hidden, () => b?.sig ?? null).catch(() => undefined),
  reload: () => void reload($).catch(() => undefined),
  create: () => void fill($, `Crie o roadmap deste projeto em ${where.rel}, ${CREATE}`),
})

/** O roadmap com o resumo e o aviso, ou o quadro sem roadmap válido (ou null antes da primeira leitura). */
const view = async ($: EngineInterface, staleAfter: number): Promise<View | Board | null> => {
  const b = await read($, board)
  if (!b?.exists || !b.roadmap) return b

  return { b, r: b.roadmap, s: summarize(b.roadmap), commits: staleCount(await read($, stale), staleAfter) }
}

/** A tabela de elementos; o Svg só fora do terminal (a tabela do terminal também o traz, mas ele não desenha nada). */
const uiOf = (table: BasicUi & { Svg?: unknown }, isTerminal: boolean): Ui =>
  !isTerminal && 'Svg' in table && table.Svg ? (table as Ui) : { Box: table.Box, Text: table.Text, Button: table.Button }

export const register: Register = (on, options) => {
  const file = String(options.file ?? '').trim() || 'docs/roadmap.json'
  const showBand = options.showBand !== false
  const staleAfter = Number(options.staleAfter ?? 10)
  const claudeCanEdit = options.claudeCanEdit !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    let root = started.cwd
    let hasGit = false
    try {
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: started.cwd, timeoutMs: 5000 })
      if (r.exitCode === 0 && r.stdout.trim()) {
        root = r.stdout.trim()
        hasGit = true
      }
    } catch {
      // Sem git: a pasta da sessão é a raiz, e não há aviso de desatualizado.
    }
    where.root = root
    where.rel = file
    where.file = isAbsolute(file) ? file : join(root, file)
    where.project = root.split(/[\\/]/).filter(Boolean).pop() ?? root
    where.hasGit = hasGit
    await load($, true)
    // A conta de commits roda logo depois, para não atrasar o primeiro prompt.
    $.clock.after(0, () => void refreshStale($).catch(() => undefined))

    try {
      await $.command.register({ name: 'roadmap', description: 'Mostra o roadmap do projeto num quadro: fases, o que está andando, as próximas e o que espera' })
    } catch {
      // Outro plugin já tem esse comando: a faixa e as ferramentas continuam.
    }
    await $.tool.register({
      name: 'roadmap_status',
      description:
        'Mostra o roadmap do projeto: a fase atual e o %, as 5 próximas tarefas (com os ids), o que está com o usuário ' +
        'e o que está esperando na fase atual (as outras fases só como contagem), e se o roadmap está desatualizado. ' +
        'Para achar o id de um item, passe query com palavras do título (até 10 itens, com id, estado, dono, fase, ' +
        'rótulo curto e notas); phase lista uma fase inteira; all: true mostra tudo sem cortes. Sem roadmap no projeto, ' +
        'diz onde criar e mostra o formato, com cada campo.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Palavras do título (ou o id) do item que você procura' },
          phase: { type: 'string', description: 'Id de uma fase: lista os itens dela que não estão feitos' },
          all: { type: 'boolean', description: 'true: sem cortes; com phase, lista também os feitos' },
        },
      },
    })
    if (claudeCanEdit) {
      await $.tool.register({
        name: 'roadmap_update',
        description:
          'Muda o estado de um item do roadmap pelo id (o roadmap_status com query acha o id). Use ao começar um item (doing), ' +
          'ao terminar (done, com a evidência: commit, arquivo, teste ou resultado), quando ele travar (blocked, com ' +
          'waitingOn) ou para reabrir (todo). "done" sem doneAt usa a data de hoje. "short" troca o rótulo curto do cartão ' +
          'no quadro (até 40 caracteres; "" tira). Com o id de uma fase, muda o estado da fase (done, doing ou todo), o ' +
          '"short" dela, e "evidence" vira o resultado do gate. Use esta ferramenta em vez de editar o JSON à mão.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id do item (ou da fase)' },
            status: { type: 'string', enum: ['done', 'doing', 'todo', 'blocked'], description: 'Sem ele, o estado fica como está' },
            evidence: { type: 'string', description: 'O que prova que está feito: commit, arquivo, teste, print' },
            doneAt: { type: 'string', description: 'Data AAAA-MM-DD; sem ela, "done" usa a de hoje' },
            note: { type: 'string', description: 'Observação que entra nas notas do item' },
            waitingOn: { type: 'string', description: 'Com "blocked": o que o item espera' },
            short: { type: 'string', description: 'Rótulo curto do cartão (até 40 caracteres; máximo 60); "" tira' },
          },
          required: ['id'],
        },
      })
      await $.tool.register({
        name: 'roadmap_add',
        description:
          'Cria um item no roadmap, numa fase que já existe; o id sai do título. Use quando surgir trabalho novo que faz ' +
          'parte do plano (não para o que vai fazer agora mesmo). "after" põe o item logo depois de outro, no arquivo e ' +
          'no caminho; sem ele, o item vai para o fim da fase. Com título longo, passe um "short" (o rótulo do cartão).',
        inputSchema: {
          type: 'object',
          properties: {
            phase: { type: 'string', description: 'Id da fase' },
            title: { type: 'string', description: 'Acionável' },
            short: { type: 'string', description: 'Rótulo curto do cartão no quadro (até 40 caracteres; máximo 60)' },
            owner: { type: 'string', description: 'Quem faz: "Claude", o nome do usuário (o owner do roadmap) ou "both"' },
            after: { type: 'string', description: 'Id do item que vem antes deste' },
            status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] },
            dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids dos itens que precisam estar feitos antes' },
            waitingOn: { type: 'string' },
            area: { type: 'string' },
            gate: { type: 'boolean', description: 'true se o item faz parte do gate da fase' },
            notes: { type: 'string' },
          },
          required: ['phase', 'title'],
        },
      })
    }
    // Mudanças feitas fora do Claude: confere a data do arquivo a cada 15 s e o git a cada 5 min.
    $.clock.every(15_000, () => {
      void load($)
        .then(changed => (changed ? refreshStale($) : undefined))
        .catch(() => undefined)
    })
    $.clock.every(300_000, () => void refreshStale($).catch(() => undefined))

    return started
  })

  // Edições no roadmap feitas pelo Claude com Edit/Write: relê na hora. Depois de um
  // git commit, lembra o Claude de marcar no roadmap o que o commit terminou.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e.tool === 'Edit' || e.tool === 'Write') && where.file && norm(e.file_path) === norm(where.file)) {
      await load($, true)
      await refreshStale($)
    }
    if (e.tool === 'Bash' && claudeCanEdit && where.file && ran.deny === undefined && !ran.isError && GIT_COMMIT.test(e.command)) {
      const note = await commitNote($, staleAfter)
      if (note) return { ...ran, context: [...(ran.context ?? []), note] }
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Commits feitos durante o turno: confere o aviso de desatualizado no fim (no máximo uma vez por minuto).
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || !where.file) return done
    await load($)
    if ((await $.clock.now()) - where.staleAt > 60_000) await refreshStale($)

    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__roadmap__roadmap_status' }, async ($, e) => {
    await load($)
    return { result: await statusText($, staleAfter, e as unknown as StatusInput) }
  }).catch(() => ({ result: 'Não consegui ler o roadmap.' }))

  on('tool.call', { tool: 'mcp__roadmap__roadmap_update' }, async ($, e) => {
    const input = e as unknown as UpdateInput
    return change($, (text, day) => applyUpdate(text, input, day), 'Claude atualizou o roadmap')
  }).catch(() => ({ deny: 'Não consegui gravar o roadmap.' }))

  on('tool.call', { tool: 'mcp__roadmap__roadmap_add' }, async ($, e) => {
    const input = e as unknown as AddInput
    return change($, (text, day) => applyAdd(text, input, day), 'Claude criou no roadmap')
  }).catch(() => ({ deny: 'Não consegui gravar o roadmap.' }))

  on('command.run', { command: 'roadmap' }, async $ => {
    await reload($)
    await $.ui.open({ id: PANE, title: 'Roadmap' })
    const v = await view($, staleAfter)
    if (v === null || !('s' in v)) return { text: v?.exists ? `Roadmap com erro: ${v.error}` : `Sem roadmap em ${where.rel}` }
    const first = v.s.next[0]

    return {
      text: [
        v.s.current ? `Fase ${v.s.current.phase.id} · ${v.s.current.pct}%` : 'Roadmap sem fases',
        first ? `próxima: ${itemLabel(first)}` : 'nada livre agora',
        v.commits !== undefined ? `⚠ ${staleChip(v.commits)}` : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($, staleAfter)
    const b = v !== null && 's' in v ? v.b : v
    const act = acts($, b, claudeCanEdit)
    const ui = uiOf($.ui.resolve(e), e.surface === 'terminal')
    if (v === null || !('s' in v)) return EmptyPane(ui, b, act)
    const width = e.props.bodyColumns
    const opened = await read($, expanded)
    const st: PaneState = {
      kb: kanban(v.r, {
        filter: await read($, filtering),
        // Um estado antigo (lista de colunas) vale como nada aberto.
        expanded: opened && !Array.isArray(opened) ? opened : {},
        width,
        seen: await read($, doneSeen),
      }),
      sel: await read($, selected),
      isDecisionsOpen: await read($, decisionsOpen),
    }
    const steps = (column: ColumnId, by: number | null) => () =>
      void update($, expanded, cur => {
        const map = cur && !Array.isArray(cur) ? cur : {}
        return { ...map, [column]: by === null ? 0 : (map[column] ?? 0) + by }
      }).catch(() => undefined)
    const boardAct: BoardActs = {
      select: id => () => void update($, selected, cur => (cur === id ? null : id)).catch(() => undefined),
      more: column => steps(column, 1),
      less: column => steps(column, null),
      filter: to => () => void update($, filtering, () => to).catch(() => undefined),
      start: act.start,
      close: () => void update($, selected, () => null).catch(() => undefined),
    }
    const toggleDecisions = () => void update($, decisionsOpen, open => !open).catch(() => undefined)

    return PaneView(ui, v, width, st, act, boardAct, toggleDecisions)
  })

  // Acima do prompt: uma linha com a fase, o %, a próxima e os botões, empilhada com o que outros plugins desenham.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!showBand || e.props.hasSurvey) return below
    const v = await view($, staleAfter)
    if (v === null || (!('s' in v) && !v.exists)) return below
    const b = 's' in v ? v.b : v
    if ((await read($, hidden)) === b.sig) return below
    const act = acts($, b, claudeCanEdit)
    const ui = uiOf($.ui.resolve(e), e.surface === 'terminal')
    const isTerminal = e.surface === 'terminal'
    const width = e.props.bodyColumns

    return (
      <ui.Box flexDirection="column">
        {'s' in v ? Band(ui, v, width, act, isTerminal) : ErrorBand(ui, b, width, act, isTerminal)}
        {below}
      </ui.Box>
    )
  })
}
