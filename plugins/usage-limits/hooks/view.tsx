import type { Elements } from 'claude-code'

import type { Advice, ApiSpend, ProjectShare, SessionRecord, Snapshot, Totals, WindowView } from '../types'
import { changesMain, usesSubHaiku } from './advisor'
import { modelKey, modelLabel } from './pricing'
import {
  HOUR,
  bar,
  clockTime,
  compact,
  durationLabel,
  readingAge,
  duration,
  hours,
  percent,
  shortLabel,
  totalTokens,
  usd,
} from './projection'
import { HEX, TOKEN_HEX, limitBarSvg, limitRingSvg, shareSvg, tokenMixSvg } from './svg'

type TerminalUi = Elements['terminal']
/** O que desktop, VS Code e mobile têm em comum: caixas, texto, SVG e botões. */
type RichUi = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg' | 'Button'>

/** Caixas, texto e botões: o que todas as superfícies desenham. */
type BasicUi = Pick<TerminalUi, 'Box' | 'Text' | 'Button'>

export type ViewData = { snap: Snapshot; totals: Totals; economy: boolean; api: ApiSpend | null; collapsed?: boolean }

/** O que os botões fazem; `details` só existe fora do painel. */
export type Actions = {
  details?: () => void
  /** ↻ Atualizar: relê a leitura mais nova e recalcula tudo. */
  reload?: () => void
  toggleEconomy: () => void
  /** Minimiza ou expande a faixa acima do prompt. */
  toggleBand?: () => void
  fillModel: (alias: string) => void
}

// ---------- textos comuns ----------

const rateText = (rate: number | undefined) =>
  rate === undefined ? '—' : `${rate.toFixed(rate < 10 ? 1 : 0).replace('.', ',')}%/h`

export const colorOf = (w: WindowView) =>
  w.verdict === 'exhausted' || w.verdict === 'exhausts'
    ? 'error'
    : w.verdict === 'tight'
      ? 'warning'
      : w.verdict === 'ok'
        ? 'success'
        : 'subtle'

const verdictText = (w: WindowView, now: number): string => {
  if (w.isRenewed) return '↺ Renovou: o uso novo aparece na próxima resposta do Claude'
  switch (w.verdict) {
    case 'exhausted':
      return `⛔ Esgotado: renova ${w.resetsAt ? clockTime(w.resetsAt, now) : '?'}`
    case 'exhausts':
      return w.exhaustAt !== undefined && w.resetsAt !== undefined
        ? `⚠ No ritmo atual acaba ~${clockTime(w.exhaustAt, now)}, ` +
            `${duration(w.resetsAt - w.exhaustAt)} antes de renovar`
        : '⚠ No ritmo atual acaba antes de renovar'
    case 'tight':
      return `△ Apertado: chega a ~${percent(w.pctAtReset ?? w.pct)} quando renovar`
    case 'ok':
      return `✓ Dura até renovar (~${percent(w.pctAtReset ?? w.pct)} no fim)`
    default:
      return 'Sem projeção para esta janela'
  }
}

const durationText = (w: WindowView) =>
  w.verdict === 'exhausted'
    ? 'esgotado'
    : w.ratePerHour === undefined
      ? '—'
      : w.hoursLeft === undefined
        ? 'sem consumo'
        : durationLabel(w)

/** Só no semanal: horas de uso no ritmo da última hora de trabalho (pelo limite de 5h). */
const workDaysText = (w: WindowView) =>
  w.workHoursLeft !== undefined
    ? `~${hours(w.workHoursLeft)} de uso no ritmo da última hora` +
      (w.activeHoursPerDay ? ` (≈ ${(w.workHoursLeft / w.activeHoursPerDay).toFixed(1).replace('.', ',')} dias de ~${Math.round(w.activeHoursPerDay)}h)` : '')
    : undefined

/** No semanal: quantos pontos por dia a conta está gastando. */
const perDayText = (w: WindowView) =>
  w.ratePerHour === undefined ? '—' : `${Math.round(w.ratePerHour * 24)} pts/dia`

const isWeekly = (w: WindowView) => w.kind.startsWith('seven_day')

/** "atualizado 09:12" e, se a leitura for velha, de quando ela é e de onde veio. */
const freshness = (snap: Snapshot) => {
  const age = readingAge(snap.readAt, snap.updatedAt)
  const base = `atualizado ${clockTime(snap.updatedAt, snap.updatedAt)}`
  if (age) return `${base} · leitura ${age}${snap.isSharedReading ? ' (outra sessão)' : ''}: atualiza na próxima resposta`
  return snap.isSharedReading ? `${base} · leitura de outra sessão` : base
}

const resetText = (w: WindowView, now: number) =>
  w.resetsAt === undefined
    ? '—'
    : `${hours((w.msToReset ?? 0) / HOUR)} · ${clockTime(w.resetsAt, now)}`

const tokensLine = (w: WindowView) =>
  w.windowTokens === undefined
    ? undefined
    : `${compact(w.windowTokens)} tokens contados nesta janela` +
      (w.tokensPerPct !== undefined
        ? ` · ≈${compact(w.tokensPerPct)} por 1% · ≈${compact(w.tokensPerPct * Math.max(0, 100 - w.pct))} restantes`
        : '')

const projectLine = (p: ProjectShare) =>
  `${p.name.padEnd(18)} ${bar(p.share * 100, 10)} ${percent(p.share * 100)} do gasto` +
  (p.points !== undefined ? ` · ≈${p.points.toFixed(1).replace('.', ',')} pts` : '')

/** Quanto cada projeto gastou na janela (até 5). */
const ProjectList = (ui: BasicUi, w: WindowView, indent: string) => {
  const { Box, Text } = ui
  const list = w.projects ?? []
  if (list.length === 0) return undefined

  return (
    <Box key="projects" flexDirection="column">
      <Text dimColor>{indent}Por projeto (esta máquina):</Text>
      {list.slice(0, 5).map(p => (
        <Text key={p.name}>
          {indent}
          {'  '}
          {projectLine(p)}
        </Text>
      ))}
    </Box>
  )
}

const EMPTY =
  'Sem dados de limite ainda: eles chegam com a primeira resposta da API e só existem em planos de assinatura (Pro/Max).'

// ---------- sessões e créditos de API ----------

const sessionRow = (r: SessionRecord, totalCost: number, isSelf: boolean) => {
  const model = r.model ? modelLabel(modelKey(r.model)) : '—'
  const share = totalCost > 0 ? ` · ${percent((r.costUsd / totalCost) * 100)}` : ''

  return `${isSelf ? '●' : '○'} ${r.project.padEnd(16).slice(0, 16)} ${model.padEnd(11)} ${compact(totalTokens(r.tokens)).padStart(6)} tok  ${usd(r.costUsd)}${share}${isSelf ? '  (esta)' : ''}`
}

/** As sessões abertas nesta máquina, o total delas e o total de hoje. */
const SessionsList = (ui: BasicUi, snap: Snapshot) => {
  const { Box, Text } = ui
  const view = snap.sessions
  if (!view) return <Text dimColor>Lista de sessões indisponível nesta máquina.</Text>

  return (
    <Box key="sessions-list" flexDirection="column">
      {view.running.map(r => (
        <Text key={r.id} bold={r.id === snap.selfId}>
          {sessionRow(r, view.total.costUsd, r.id === snap.selfId)}
        </Text>
      ))}
      <Text bold>
        Total ({view.total.count} {view.total.count === 1 ? 'sessão aberta' : 'sessões abertas'}): {compact(totalTokens(view.total.tokens))} tok ·{' '}
        {usd(view.total.costUsd)}
      </Text>
      <Text dimColor>
        Hoje nesta máquina, fechadas inclusive: {view.today.count} sessões · {compact(totalTokens(view.today.tokens))} tok ·{' '}
        {usd(view.today.costUsd)}
      </Text>
      <Text dimColor>Custo equivalente em preço de API; no plano, o que conta são os limites de 5h e semanal.</Text>
    </Box>
  )
}

const dayMonth = (t: number) => {
  const d = new Date(t)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Os créditos de API do Console: gasto, ritmo e quando acabam. */
const ApiCard = (ui: BasicUi, spend: ApiSpend | null, now: number) => {
  const { Box, Text } = ui
  if (!spend) return undefined
  const pct = spend.creditUsd > 0 ? (spend.spentUsd / spend.creditUsd) * 100 : 0
  const color = spend.runsOutAt !== undefined ? 'error' : spend.projectedUsd > spend.creditUsd * 0.85 ? 'warning' : 'success'

  return (
    <Box key="api" flexDirection="column" borderStyle="round" borderColor={spend.problem ? 'warning' : color} paddingX={1}>
      <Text bold>Créditos de API (Console)</Text>
      {spend.problem && <Text color="warning">{spend.problem}</Text>}
      <Text>
        <Text color={color}>{bar(pct, 20)}</Text> {usd(spend.spentUsd)} de {usd(spend.creditUsd)} · {percent(pct)}
      </Text>
      <Text dimColor>
        Ciclo {dayMonth(spend.cycleStart)} a {dayMonth(spend.cycleEnd)} · {usd(spend.dailyUsd)}/dia · renova em{' '}
        {Math.max(0, Math.ceil((spend.cycleEnd - now) / 86_400_000))} dias
      </Text>
      <Text color={color}>
        {spend.runsOutAt !== undefined
          ? `⚠ Nesse ritmo o crédito acaba ~${dayMonth(spend.runsOutAt)}, antes de renovar; depois as chamadas param (ou usam crédito comprado).`
          : `✓ Nesse ritmo o ciclo fecha com ~${usd(spend.projectedUsd)} gastos.`}
      </Text>
      {spend.byModel.slice(0, 5).map(m => (
        <Text key={m.model} dimColor>
          {'  '}
          {m.model}: {usd(m.usd)}
        </Text>
      ))}
      <Text dimColor>Não conta nos limites de 5h e semanal do plano. Atualiza a cada 10 min (o Console leva ~5 min).</Text>
    </Box>
  )
}

/** "3 sessões · 4.2M tokens · US$ 12,40" ou, sozinha, os números desta. */
const usageSummary = (snap: Snapshot, totals: Totals, api: ApiSpend | null) => {
  const all = snap.sessions?.total
  // Sessões gravadas por versões antigas do mod têm custo mas 0 tokens: sem tokens, só o custo.
  const tokens = (n: number) => (n > 0 ? [`${compact(n)} tokens`] : [])
  const head = (
    all && all.count > 1
      ? [`${all.count} sessões`, ...tokens(totalTokens(all.tokens)), usd(all.costUsd)]
      : [...tokens(totalTokens(totals)), ...(snap.costUsd !== undefined ? [usd(snap.costUsd)] : [])]
  ).join(' · ')

  return api && !api.problem ? `${head} · API ${usd(api.spentUsd)}/${Math.round(api.creditUsd)}` : head
}

// ---------- recomendação de modelo ----------

const adviceColor = (a: Advice) => (a.isFine ? 'success' : a.pick ? 'warning' : 'error')

const setupText = (a: Advice, economy: boolean) =>
  [
    `principal ${a.mainModel ? modelLabel(a.mainModel) : '—'}${a.mainEffort ? ` · effort ${a.mainEffort}` : ''}`,
    a.subShare > 0
      ? `subagentes ${percent(a.subShare * 100)} do gasto (${a.subModels.map(modelLabel).join(', ')})`
      : 'sem subagentes nesta janela',
    `economia ${economy ? 'ligada' : 'desligada'}`,
  ].join(' · ')

/** Botões que aplicam a recomendação; `always` mostra o liga/desliga da economia mesmo sem recomendação. */
const AdviceButtons = (ui: BasicUi, a: Advice | undefined, economy: boolean, actions: Actions, always: boolean) => {
  const { Box, Button } = ui
  const buttons = []
  if (!economy && (always || usesSubHaiku(a?.pick))) {
    buttons.push(
      <Button key="economy-on" label="Haiku nos subagentes" variant="primary" onPress={actions.toggleEconomy} />,
    )
  }
  if (economy) {
    buttons.push(<Button key="economy-off" label="Desligar economia" onPress={actions.toggleEconomy} />)
  }
  if (a && changesMain(a.pick, a.mainModel)) {
    buttons.push(<Button key="model-sonnet" label="/model sonnet" onPress={() => actions.fillModel('sonnet')} />)
  }
  if (a?.pick === 'all-haiku') {
    buttons.push(<Button key="model-haiku" label="/model haiku" onPress={() => actions.fillModel('haiku')} />)
  }
  if (actions.details) {
    buttons.push(<Button key="details" label="Detalhes" plain onPress={actions.details} />)
  }
  // Na faixa o ↻ fica junto dos outros botões; no painel ele fica no topo.
  if (actions.reload) {
    buttons.push(<Button key="reload" label="↻ Atualizar" plain onPress={actions.reload} />)
  }

  return buttons.length > 0 ? (
    <Box key="buttons" flexDirection="row" columnGap={2} flexWrap="wrap">
      {buttons}
    </Box>
  ) : undefined
}

/** Cartão "Qual modelo usar" do painel. */
const AdviceCard = (ui: BasicUi, a: Advice | undefined, economy: boolean, actions: Actions) => {
  const { Box, Text } = ui

  return (
    <Box
      key="advice"
      flexDirection="column"
      borderStyle="round"
      borderColor={a ? adviceColor(a) : 'subtle'}
      paddingX={1}
    >
      <Text bold>Qual modelo usar</Text>
      {a === undefined ? (
        <Text dimColor>A recomendação aparece depois de algumas respostas com os limites medidos.</Text>
      ) : (
        <Box flexDirection="column">
          <Text color={adviceColor(a)}>{a.headline}</Text>
          <Text dimColor>{setupText(a, economy)}</Text>
          {a.scenarios.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                Se o resto da janela {a.windowLabel.toLowerCase()} seguir assim (pelo gasto{' '}
                {a.mixBasis === 'recent' ? 'das últimas 3 horas com uso' : 'da janela toda'}):
              </Text>
              {a.scenarios.map(s => (
                <Text key={s.id} bold={s.id === a.pick} color={s.lasts ? 'success' : 'error'}>
                  {s.id === a.pick ? '› ' : '  '}
                  {s.label.padEnd(30)} dura {s.hoursLeft === undefined ? '—' : `~${hours(s.hoursLeft)}`} · ~
                  {percent(s.pctAtReset)} no reset · −{percent((1 - s.factor) * 100)} de gasto
                </Text>
              ))}
            </Box>
          )}
          {a.tip !== undefined && <Text dimColor>{a.tip}</Text>}
        </Box>
      )}
      {AdviceButtons(ui, a, economy, { ...actions, reload: undefined }, true)}
      <Text dimColor>
        Estimativa pelo preço de API de cada modelo; a assinatura pode pesar os modelos de outro jeito.
      </Text>
    </Box>
  )
}

// ---------- desktop, VS Code, mobile ----------

/** Um número com o rótulo em cima: "Dura" / "até renovar". */
const Fact = (ui: RichUi, key: string, label: string, value: string, color?: string) => {
  const { Box, Text } = ui

  return (
    <Box key={key} flexDirection="column" minWidth={104}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )
}

/** "dura até renovar", "~3,2h", "esgotado"… para o cartão do painel. */
const lastsText = (w: WindowView) => {
  if (w.isRenewed) return 'renovado'
  if (w.verdict === 'exhausted') return 'esgotado'
  if (w.ratePerHour === undefined) return '—'
  if (w.hoursLeft === undefined) return 'parado'
  return w.verdict !== 'exhausts' && w.hoursLeft >= (w.msToReset ?? 0) / HOUR ? 'até renovar' : `~${hours(w.hoursLeft)}`
}

const renewsText = (w: WindowView, now: number) =>
  w.resetsAt === undefined ? '—' : `${clockTime(w.resetsAt, now)} · em ${duration(w.msToReset ?? 0)}`

/** Quanto cada projeto gastou na janela, com barrinhas. */
const ProjectBars = (ui: RichUi, w: WindowView) => {
  const { Box, Text, Svg } = ui
  const list = (w.projects ?? []).slice(0, 4)
  if (list.length === 0) return undefined

  return (
    <Box key="projects" flexDirection="column" rowGap={0}>
      <Text dimColor>Por projeto, nesta máquina</Text>
      {list.map(p => (
        <Box key={p.name} flexDirection="row" columnGap={1} alignItems="center">
          <Box width={120}>
            <Text wrap="truncate-end">{p.name}</Text>
          </Box>
          <Svg source={shareSvg(p.share, 72, 8, HEX[w.verdict])} alt={`${p.name}: ${percent(p.share * 100)} do gasto`} width={72} height={8} />
          <Text dimColor>
            {percent(p.share * 100)}
            {p.points !== undefined ? ` · ≈${p.points.toFixed(1).replace('.', ',')} pts` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** Cartão de um limite: o anel com o %, os números ao lado e o veredito embaixo. */
const LimitCard = (ui: RichUi, w: WindowView, now: number) => {
  const { Box, Text, Svg } = ui
  const color = w.isRenewed ? 'subtle' : colorOf(w)
  const work = workDaysText(w)

  return (
    <Box
      key={w.kind}
      flexDirection="column"
      flexGrow={1}
      minWidth={300}
      borderStyle="round"
      borderColor={w.verdict === 'exhausts' || w.verdict === 'exhausted' ? 'error' : 'subtle'}
      paddingX={1}
      paddingY={1}
      rowGap={1}
    >
      <Box flexDirection="row" columnGap={2} alignItems="center">
        <Svg
          source={limitRingSvg(w, now, 88)}
          alt={`${w.label}: ${percent(w.pct)} usado, ${lastsText(w)}`}
          width={88}
          height={88}
        />
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          <Text bold>{w.label}</Text>
          <Box flexDirection="row" columnGap={2} rowGap={1} flexWrap="wrap">
            {Fact(ui, 'lasts', 'Dura', lastsText(w), color)}
            {Fact(ui, 'renews', 'Renova', renewsText(w, now))}
            {isWeekly(w)
              ? Fact(ui, 'rate', 'Ritmo da conta', perDayText(w))
              : Fact(ui, 'rate', 'Ritmo recente', rateText(w.recentRatePerHour))}
          </Box>
        </Box>
      </Box>
      <Text color={color}>{verdictText(w, now)}</Text>
      {work !== undefined && <Text dimColor>{work}</Text>}
      {ProjectBars(ui, w)}
    </Box>
  )
}

/** Uma linha de cenário da recomendação, em colunas alinhadas. */
const ScenarioRow = (ui: RichUi, a: Advice, s: Advice['scenarios'][number]) => {
  const { Box, Text } = ui
  const isPick = s.id === a.pick

  return (
    <Box key={s.id} flexDirection="row" columnGap={2}>
      <Box flexGrow={1} minWidth={200}>
        <Text bold={isPick}>
          {isPick ? '› ' : '  '}
          {s.label}
        </Text>
      </Box>
      <Box width={88}>
        <Text color={s.lasts ? 'success' : 'error'}>{s.hoursLeft === undefined ? '—' : `~${hours(s.hoursLeft)}`}</Text>
      </Box>
      <Box width={88}>
        <Text dimColor>{percent(s.pctAtReset)} no reset</Text>
      </Box>
      <Box width={80}>
        <Text dimColor>−{percent((1 - s.factor) * 100)} gasto</Text>
      </Box>
    </Box>
  )
}

/** "Qual modelo usar" no desktop: a frase, o que está rodando e os cenários numa tabela. */
const RichAdviceCard = (ui: RichUi, a: Advice | undefined, economy: boolean, actions: Actions) => {
  const { Box, Text } = ui

  return (
    <Box key="advice" flexDirection="column" borderStyle="round" borderColor={a && !a.isFine ? adviceColor(a) : 'subtle'} paddingX={1} paddingY={1} rowGap={1}>
      <Text bold>Qual modelo usar</Text>
      {a === undefined ? (
        <Text dimColor>A recomendação aparece depois de algumas respostas com os limites medidos.</Text>
      ) : (
        <Box flexDirection="column" rowGap={1}>
          <Text color={adviceColor(a)}>{a.headline}</Text>
          <Text dimColor>{setupText(a, economy)}</Text>
          {a.scenarios.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>
                Se o resto da janela {a.windowLabel.toLowerCase()} seguir o gasto{' '}
                {a.mixBasis === 'recent' ? 'das últimas 3 horas com uso' : 'da janela toda'}:
              </Text>
              {a.scenarios.map(s => ScenarioRow(ui, a, s))}
            </Box>
          )}
          {a.tip !== undefined && <Text dimColor>{a.tip}</Text>}
        </Box>
      )}
      {AdviceButtons(ui, a, economy, { ...actions, reload: undefined, details: undefined }, true)}
    </Box>
  )
}

/** As sessões abertas numa tabela, com a parte de cada uma no custo. */
const SessionsTable = (ui: RichUi, snap: Snapshot) => {
  const { Box, Text, Svg } = ui
  const view = snap.sessions
  if (!view) return <Text dimColor>Lista de sessões indisponível nesta máquina.</Text>
  const total = view.total.costUsd

  return (
    <Box key="sessions-table" flexDirection="column">
      {view.running.map(r => {
        const share = total > 0 ? r.costUsd / total : 0
        const isSelf = r.id === snap.selfId
        const tokens = totalTokens(r.tokens)

        return (
          <Box key={r.id} flexDirection="row" columnGap={2} alignItems="center">
            <Box width={150}>
              <Text bold={isSelf} wrap="truncate-end">
                {isSelf ? '● ' : '○ '}
                {r.project}
              </Text>
            </Box>
            <Box width={84}>
              <Text dimColor>{r.model ? modelLabel(modelKey(r.model)) : '—'}</Text>
            </Box>
            <Box width={64}>
              <Text dimColor>{tokens > 0 ? compact(tokens) : '—'}</Text>
            </Box>
            <Box width={96}>
              <Text>{usd(r.costUsd)}</Text>
            </Box>
            <Svg source={shareSvg(share)} alt={`${percent(share * 100)} do custo`} width={64} height={8} />
            <Text dimColor>{percent(share * 100)}</Text>
          </Box>
        )
      })}
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        <Text bold>
          {view.total.count} {view.total.count === 1 ? 'sessão aberta' : 'sessões abertas'} · {usd(view.total.costUsd)}
        </Text>
        <Text dimColor>
          hoje: {view.today.count} sessões · {usd(view.today.costUsd)}
        </Text>
      </Box>
    </Box>
  )
}

/** Sessões da máquina e os tokens desta. */
const UsageCard = (ui: RichUi, { snap, totals }: ViewData, px: number) => {
  const { Box, Text, Svg } = ui
  const tokens = totalTokens(totals)
  const legend = [
    ['entrada', totals.input, TOKEN_HEX.input],
    ['saída', totals.output, TOKEN_HEX.output],
    ['cache escrito', totals.cacheWrite, TOKEN_HEX.cacheWrite],
    ['cache lido', totals.cacheRead, TOKEN_HEX.cacheRead],
  ] as const

  return (
    <Box key="usage" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} paddingY={1} rowGap={1}>
      <Text bold>Sessões</Text>
      {SessionsTable(ui, snap)}
      <Text bold>Esta sessão</Text>
      <Box flexDirection="row" columnGap={2} rowGap={1} flexWrap="wrap">
        {Fact(ui, 'tokens', 'Tokens', compact(tokens))}
        {Fact(ui, 'cost', 'Custo', snap.costUsd === undefined ? '—' : usd(snap.costUsd))}
        {Fact(ui, 'turns', 'Turnos', String(totals.turns))}
        {Fact(ui, 'ctx', 'Contexto', snap.contextPercent === undefined ? '—' : `${snap.contextPercent}%`)}
      </Box>
      {tokens > 0 && <Svg source={tokenMixSvg(totals, px, 10)} alt="Composição dos tokens da sessão" width={px} height={10} />}
      {tokens > 0 && (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {legend.map(([label, n, color]) => (
            <Text key={label}>
              <Text color={color}>●</Text> <Text dimColor>{label}</Text> {compact(n)}
            </Text>
          ))}
        </Box>
      )}
      <Text dimColor>Custo equivalente em preço de API; no plano, o que conta são os limites de 5h e semanal.</Text>
    </Box>
  )
}

/** Painel `/limites` em superfícies que desenham SVG. */
export const RichPane = (ui: RichUi, data: ViewData, columns: number, actions: Actions) => {
  const { Box, Text, Button } = ui
  const { snap } = data
  const now = snap.updatedAt
  const px = Math.max(220, Math.min(760, columns * 7 - 48))
  const stale = isStale(snap)

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2} flexWrap="wrap">
        <Text bold>Limites de uso</Text>
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Text color={stale ? 'warning' : undefined} dimColor={!stale}>
            {freshness(snap)}
          </Text>
          {actions.reload && <Button key="reload-top" label="↻ Atualizar" onPress={actions.reload} />}
        </Box>
      </Box>
      {snap.windows.length === 0 && <Text dimColor>{EMPTY}</Text>}
      <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap">
        {snap.windows.map(w => LimitCard(ui, w, now))}
      </Box>
      {RichAdviceCard(ui, snap.advice, data.economy, actions)}
      {UsageCard(ui, data, px)}
      {ApiCard(ui, data.api, now)}
      <Text dimColor>
        Anel cheio: uso · parte clara: projeção até renovar · traço: onde o uso estaria num ritmo uniforme. Estimativas pelo preço de API de
        cada modelo; a assinatura pode pesar os modelos de outro jeito.
      </Text>
    </Box>
  )
}

// ---------- terminal ----------

/** Painel `/limites` no terminal: só texto. */
export const TerminalPane = (ui: TerminalUi, { snap, totals, economy, api }: ViewData, columns: number, actions: Actions) => {
  const { Box, Text } = ui
  const now = snap.updatedAt
  const width = Math.max(10, Math.min(30, columns - 30))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>{freshness(snap)}</Text>
        {actions.reload && <ui.Button key="reload-top" label="↻ Atualizar" onPress={actions.reload} />}
      </Box>
      {snap.windows.length === 0 && <Text dimColor>{EMPTY}</Text>}
      {snap.windows.map(w => {
        const tokens = tokensLine(w)

        return (
          <Box key={w.kind} flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>{w.label.padEnd(10)}</Text>
              <Text color={colorOf(w)}>{bar(w.pct, width)}</Text> {percent(w.pct)}
            </Text>
            <Text bold>
              {'  '}duração estimada {durationText(w)} · reset em {resetText(w, now)}
            </Text>
            <Text dimColor>
              {'  '}
              {isWeekly(w)
                ? `ritmo da conta ${perDayText(w)}${workDaysText(w) ? ` · ${workDaysText(w)}` : ''}`
                : `ritmo ${rateText(w.recentRatePerHour)} recente · ${rateText(w.windowRatePerHour)} média da janela`}
            </Text>
            <Text color={colorOf(w)}>
              {'  '}
              {verdictText(w, now)}
            </Text>
            {tokens !== undefined && (
              <Text dimColor>
                {'  '}
                {tokens}
              </Text>
            )}
            {ProjectList(ui, w, '  ')}
          </Box>
        )
      })}
      <Box marginTop={1}>{AdviceCard(ui, snap.advice, economy, actions)}</Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Sessões</Text>
        {SessionsList(ui, snap)}
      </Box>
      {ApiCard(ui, api, now) !== undefined && <Box marginTop={1}>{ApiCard(ui, api, now)}</Box>}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Esta sessão</Text>
        <Text>
          {'  '}entrada {compact(totals.input)} · saída {compact(totals.output)} · cache lido{' '}
          {compact(totals.cacheRead)} · cache escrito {compact(totals.cacheWrite)}
        </Text>
        <Text>
          {'  '}total {compact(totalTokens(totals))} em {totals.turns} turno{totals.turns === 1 ? '' : 's'}
          {snap.costUsd !== undefined && ` · custo ${usd(snap.costUsd)}`}
          {snap.contextPercent !== undefined && ` · contexto ${snap.contextPercent}%`}
        </Text>
      </Box>
    </Box>
  )
}

// ---------- faixa acima do prompt (desktop e terminal) ----------

/** Leitura com mais de 2h: os números podem estar bem atrás da conta. */
const STALE_MS = 2 * HOUR

const isStale = (snap: Snapshot) => snap.readAt !== undefined && snap.updatedAt - snap.readAt > STALE_MS

/** "Semana" na faixa do desktop, que tem espaço; "Sem" no terminal. */
const bandLabel = (kind: string, isWide: boolean) =>
  isWide && kind === 'seven_day' ? 'Semana' : shortLabel(kind)

/** O que vem depois do %: quanto dura e quando renova, sem repetir o óbvio. */
export const bandDetail = (w: WindowView, now: number): string => {
  const renews = w.resetsAt === undefined ? '' : `renova ${clockTime(w.resetsAt, now)}`
  if (w.isRenewed) return 'renovado'
  if (w.verdict === 'exhausted') return `esgotado · volta ${clockTime(w.resetsAt ?? now, now)}`
  const toReset = (w.msToReset ?? 0) / HOUR
  const lasts =
    w.ratePerHour === undefined
      ? undefined
      : w.hoursLeft === undefined
        ? 'parado'
        : w.verdict === 'exhausts'
          ? `acaba em ~${hours(w.hoursLeft)}`
          : w.hoursLeft >= toReset
            ? 'dura até renovar'
            : `dura ~${hours(w.hoursLeft)}`

  return [lasts, renews].filter(Boolean).join(' · ')
}

/** Marca curta da faixa minimizada. */
const mark = (w: WindowView) =>
  w.verdict === 'exhausted' ? ' ⛔' : w.verdict === 'exhausts' ? ' ⚠' : w.verdict === 'tight' ? ' △' : ''

/** "2 sessões · 4,2M tokens · US$ 12,40" e, se for o caso, de quando é a leitura. */
const metaLine = (data: ViewData) => {
  const { snap, totals, api } = data
  const age = readingAge(snap.readAt, snap.updatedAt)

  return {
    text: usageSummary(snap, totals, api),
    age: age ? `leitura ${age}${isStale(snap) ? ': atualiza na próxima resposta' : ''}` : undefined,
  }
}

/**
 * A recomendação só aparece na faixa quando um limite acaba antes de renovar e
 * a leitura é recente; o texto inteiro fica em Detalhes.
 */
const bandAdvice = (data: ViewData) => {
  const a = data.snap.advice
  const w = data.snap.windows.find(v => v.kind === a?.windowKind)
  if (!a || !w || w.verdict !== 'exhausts' || isStale(data.snap)) return undefined
  const when = w.exhaustAt !== undefined ? ` ~${clockTime(w.exhaustAt, data.snap.updatedAt)}` : ''

  return { advice: a, text: `⚠ ${w.label} acaba${when}, antes de renovar` }
}

/** Botões da recomendação que mudam algo agora. */
const adviceActions = (ui: BasicUi, a: Advice, economy: boolean, actions: Actions) => {
  const { Button } = ui
  const buttons = []
  if (!economy && usesSubHaiku(a.pick)) {
    buttons.push(<Button key="economy-on" label="Haiku nos subagentes" variant="primary" onPress={actions.toggleEconomy} />)
  }
  if (changesMain(a.pick, a.mainModel)) {
    buttons.push(<Button key="model-sonnet" label="/model sonnet" onPress={() => actions.fillModel('sonnet')} />)
  }
  if (a.pick === 'all-haiku') {
    buttons.push(<Button key="model-haiku" label="/model haiku" onPress={() => actions.fillModel('haiku')} />)
  }
  return buttons
}

/** Os controles à direita: economia, atualizar, detalhes e minimizar. */
const bandControls = (ui: BasicUi, economy: boolean, actions: Actions, collapsed: boolean) => {
  const { Box, Button } = ui

  return (
    <Box key="controls" flexDirection="row" columnGap={1} alignItems="center">
      {economy && !collapsed && (
        <Button key="economy-off" label="Economia ligada ✕" plain onPress={actions.toggleEconomy} />
      )}
      {actions.reload && !collapsed && <Button key="reload" label="↻" plain onPress={actions.reload} />}
      {actions.details && !collapsed && <Button key="details" label="Detalhes" plain onPress={actions.details} />}
      {actions.toggleBand && (
        <Button
          key={collapsed ? 'band-expand' : 'band-collapse'}
          label={collapsed ? '▴' : '▾'}
          plain
          onPress={actions.toggleBand}
        />
      )}
    </Box>
  )
}

/** Faixa minimizada: uma linha com os % e o botão de expandir. */
const CollapsedBand = (ui: BasicUi, data: ViewData, actions: Actions, isWide: boolean) => {
  const { Box, Text } = ui
  const { snap } = data
  const all = snap.sessions?.total

  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
      <Box flexDirection="row" columnGap={2} alignItems="center">
        {snap.windows.map(w => (
          <Text key={w.kind}>
            <Text dimColor>{bandLabel(w.kind, isWide)}</Text>{' '}
            <Text bold color={w.isRenewed ? 'subtle' : colorOf(w)}>
              {percent(w.pct)}
              {mark(w)}
            </Text>
          </Text>
        ))}
        {all && all.count > 1 && (
          <Text key="cost" dimColor>
            {usd(all.costUsd)}
          </Text>
        )}
        {isStale(snap) && (
          <Text key="stale" color="warning">
            leitura {readingAge(snap.readAt, snap.updatedAt)}
          </Text>
        )}
      </Box>
      {bandControls(ui, data.economy, actions, true)}
    </Box>
  )
}

/** Faixa acima do prompt no desktop: uma linha por assunto, controles à direita. */
export const RichBand = (ui: RichUi, data: ViewData, actions: Actions) => {
  if (data.collapsed) return CollapsedBand(ui, data, actions, true)
  const { Box, Text, Svg } = ui
  const { snap } = data
  const now = snap.updatedAt
  const meta = metaLine(data)
  const advice = bandAdvice(data)

  return (
    <Box flexDirection="column" rowGap={0}>
      <Box flexDirection="row" columnGap={2}>
        <Box flexDirection="row" columnGap={4} rowGap={0} alignItems="center" flexWrap="wrap">
          {snap.windows.map(w => (
            <Box key={w.kind} flexDirection="row" columnGap={1} alignItems="center">
              <Text bold>{bandLabel(w.kind, true)}</Text>
              <Svg
                source={limitBarSvg(w, now, 72, { height: 10 })}
                alt={`${w.label}: ${percent(w.pct)} usado`}
                width={72}
                height={10}
              />
              <Text bold color={w.isRenewed ? 'subtle' : colorOf(w)}>
                {percent(w.pct)}
              </Text>
              <Text dimColor>{bandDetail(w, now)}</Text>
            </Box>
          ))}
        </Box>
      </Box>
      {advice && (
        <Box key="advice" flexDirection="row" columnGap={2} alignItems="center" flexWrap="wrap">
          <Text color="error">{advice.text}</Text>
          {adviceActions(ui, advice.advice, data.economy, actions)}
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        <Text dimColor>
          {meta.text}
          {meta.age !== undefined && (
            <Text color={isStale(snap) ? 'warning' : undefined} dimColor={!isStale(snap)}>
              {' · '}
              {meta.age}
            </Text>
          )}
        </Text>
        {bandControls(ui, data.economy, actions, false)}
      </Box>
    </Box>
  )
}

/** Faixa acima do prompt no terminal: o mesmo desenho, com barras de texto. */
export const TerminalBand = (ui: TerminalUi, data: ViewData, actions: Actions) => {
  const term = { ...actions, details: undefined }
  if (data.collapsed) return CollapsedBand(ui, data, term, false)
  const { Box, Text } = ui
  const { snap } = data
  const now = snap.updatedAt
  const meta = metaLine(data)
  const advice = bandAdvice(data)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap">
          {snap.windows.map(w => (
            <Text key={w.kind}>
              <Text bold>{bandLabel(w.kind, false)}</Text>{' '}
              <Text color={w.isRenewed ? 'subtle' : colorOf(w)}>{bar(w.pct, 8)}</Text>{' '}
              <Text bold color={w.isRenewed ? 'subtle' : colorOf(w)}>
                {percent(w.pct)}
              </Text>{' '}
              <Text dimColor>{bandDetail(w, now)}</Text>
            </Text>
          ))}
        </Box>
      </Box>
      {advice && (
        <Box key="advice" flexDirection="row" columnGap={2} flexWrap="wrap">
          <Text color="error">{advice.text}</Text>
          {adviceActions(ui, advice.advice, data.economy, term)}
        </Box>
      )}
      <Box flexDirection="row" columnGap={2}>
        <Text dimColor>
          {meta.text}
          {meta.age !== undefined && (
            <Text color={isStale(snap) ? 'warning' : undefined} dimColor={!isStale(snap)}>
              {' · '}
              {meta.age}
            </Text>
          )}
          {' · /limites'}
        </Text>
        {bandControls(ui, data.economy, term, false)}
      </Box>
    </Box>
  )
}
