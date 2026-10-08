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
import { TOKEN_HEX, limitBarSvg, tokenMixSvg } from './svg'

type TerminalUi = Elements['terminal']
/** O que desktop, VS Code e mobile têm em comum: caixas, texto, SVG e botões. */
type RichUi = Pick<Elements['desktop'], 'Box' | 'Text' | 'Svg' | 'Button'>

/** Caixas, texto e botões: o que todas as superfícies desenham. */
type BasicUi = Pick<TerminalUi, 'Box' | 'Text' | 'Button'>

export type ViewData = { snap: Snapshot; totals: Totals; economy: boolean; api: ApiSpend | null }

/** O que os botões fazem; `details` só existe fora do painel. */
export type Actions = {
  details?: () => void
  /** ↻ Atualizar: relê a leitura mais nova e recalcula tudo. */
  reload?: () => void
  toggleEconomy: () => void
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
  switch (w.verdict) {
    case 'exhausted':
      return `⛔ Esgotado — volta às ${w.resetsAt ? clockTime(w.resetsAt, now) : '?'}`
    case 'exhausts':
      return w.exhaustAt !== undefined && w.resetsAt !== undefined
        ? `⚠ No ritmo atual acaba ~${clockTime(w.exhaustAt, now)}, ` +
            `${duration(w.resetsAt - w.exhaustAt)} antes do reset`
        : '⚠ No ritmo atual acaba antes do reset'
    case 'tight':
      return `△ Apertado: chega a ~${percent(w.pctAtReset ?? w.pct)} no reset`
    case 'ok':
      return `✓ Dura até o reset (~${percent(w.pctAtReset ?? w.pct)} no fim)`
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

/** No semanal medido por trabalho: quantos dias isso dá no seu ritmo de horas por dia. */
const workDaysText = (w: WindowView) =>
  w.rateSource === 'work' && w.hoursLeft !== undefined && w.activeHoursPerDay
    ? `≈ ${(w.hoursLeft / w.activeHoursPerDay).toFixed(1).replace('.', ',')} dias trabalhando ~${Math.round(w.activeHoursPerDay)}h/dia`
    : undefined

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
  const head =
    all && all.count > 1
      ? `${all.count} sessões · ${compact(totalTokens(all.tokens))} tokens · ${usd(all.costUsd)}`
      : `${compact(totalTokens(totals))} tokens${snap.costUsd !== undefined ? ` · ${usd(snap.costUsd)}` : ''}`

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

/** A linha de recomendação das faixas acima do prompt. */
const AdviceLine = (ui: BasicUi, a: Advice | undefined, economy: boolean, actions: Actions) => {
  const { Box, Text } = ui
  if (a === undefined) return AdviceButtons(ui, a, economy, actions, false)

  return (
    <Box key="advice" flexDirection="column">
      <Text color={adviceColor(a)} dimColor={a.isFine}>
        {economy && !a.isFine ? `${a.headline} (economia ligada)` : a.headline}
      </Text>
      {AdviceButtons(ui, a, economy, actions, false)}
    </Box>
  )
}

// ---------- desktop, VS Code, mobile ----------

const Stat = (ui: RichUi, key: string, label: string, value: string, color?: string) => {
  const { Box, Text } = ui

  return (
    <Box key={key} flexDirection="column" minWidth={12}>
      <Text dimColor>{label}</Text>
      <Text bold color={color}>
        {value}
      </Text>
    </Box>
  )
}

const WindowCard = (ui: RichUi, w: WindowView, now: number, px: number) => {
  const { Box, Text, Svg } = ui
  const tokens = tokensLine(w)

  return (
    <Box key={w.kind} flexDirection="column" borderStyle="round" borderColor={colorOf(w)} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{w.label}</Text>
        <Text bold color={colorOf(w)}>
          {percent(w.pct)} usado
        </Text>
      </Box>
      <Svg
        source={limitBarSvg(w, now, px)}
        alt={`${w.label}: ${percent(w.pct)} usado, ${durationText(w)} restantes`}
        width={px}
        height={30}
      />
      <Box flexDirection="row" columnGap={3} flexWrap="wrap">
        {Stat(ui, 'dur', 'Duração estimada', durationText(w), colorOf(w))}
        {Stat(ui, 'reset', 'Reset em', resetText(w, now))}
        {w.rateSource === 'work'
          ? Stat(ui, 'rate', 'Ritmo de trabalho', `${rateText(w.ratePerHour)} de uso`)
          : Stat(ui, 'rate', 'Ritmo recente', rateText(w.recentRatePerHour))}
        {Stat(ui, 'avg', 'Média da janela', rateText(w.windowRatePerHour))}
      </Box>
      {workDaysText(w) !== undefined && <Text dimColor>{workDaysText(w)}</Text>}
      <Text color={colorOf(w)}>{verdictText(w, now)}</Text>
      {tokens !== undefined && <Text dimColor>{tokens}</Text>}
      {ProjectList(ui, w, '')}
    </Box>
  )
}

const SessionCard = (ui: RichUi, { snap, totals }: ViewData, px: number) => {
  const { Box, Text, Svg } = ui
  const tokens = totalTokens(totals)
  const legend = [
    ['entrada', totals.input, TOKEN_HEX.input],
    ['saída', totals.output, TOKEN_HEX.output],
    ['cache escrito', totals.cacheWrite, TOKEN_HEX.cacheWrite],
    ['cache lido', totals.cacheRead, TOKEN_HEX.cacheRead],
  ] as const

  return (
    <Box key="session" flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
      <Text bold>Sessões</Text>
      {SessionsList(ui, snap)}
      <Text bold>Esta sessão</Text>
      <Box flexDirection="row" columnGap={3} flexWrap="wrap">
        {Stat(ui, 'tokens', 'Tokens', compact(tokens))}
        {Stat(ui, 'cost', 'Custo', snap.costUsd === undefined ? '—' : usd(snap.costUsd))}
        {Stat(ui, 'turns', 'Turnos', String(totals.turns))}
        {Stat(ui, 'ctx', 'Contexto', snap.contextPercent === undefined ? '—' : `${snap.contextPercent}%`)}
      </Box>
      {tokens > 0 && (
        <Svg source={tokenMixSvg(totals, px)} alt="Composição dos tokens da sessão" width={px} height={12} />
      )}
      {tokens > 0 && (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {legend.map(([label, n, color]) => (
            <Text key={label}>
              <Text color={color}>■</Text> {label} {compact(n)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

/** Painel `/limites` em superfícies que desenham SVG. */
export const RichPane = (ui: RichUi, data: ViewData, columns: number, actions: Actions) => {
  const { Box, Text, Button } = ui
  const { snap } = data
  const now = snap.updatedAt
  const px = Math.max(220, Math.min(820, columns * 7 - 24))

  return (
    <Box flexDirection="column" rowGap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>Limites de uso</Text>
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Text dimColor>{freshness(snap)}</Text>
          {actions.reload && <Button key="reload-top" label="↻ Atualizar" onPress={actions.reload} />}
        </Box>
      </Box>
      {snap.windows.length === 0 && <Text dimColor>{EMPTY}</Text>}
      {snap.windows.map(w => WindowCard(ui, w, now, px))}
      {AdviceCard(ui, snap.advice, data.economy, actions)}
      {SessionCard(ui, data, px)}
      {ApiCard(ui, data.api, now)}
      <Text dimColor>
        Barra cheia: uso · hachura: projeção até o reset · traço: onde o uso estaria num ritmo uniforme
      </Text>
    </Box>
  )
}

/** Faixa compacta acima do prompt no desktop. */
export const RichBand = (ui: RichUi, data: ViewData, actions: Actions) => {
  const { Box, Text, Svg } = ui
  const { snap, totals } = data
  const now = snap.updatedAt

  return (
    <Box flexDirection="column">
    <Box flexDirection="row" columnGap={3} alignItems="center" flexWrap="wrap">
      {snap.windows.map(w => (
        <Box key={w.kind} flexDirection="row" columnGap={1} alignItems="center">
          <Text bold>{shortLabel(w.kind)}</Text>
          <Svg
            source={limitBarSvg(w, now, 90, { height: 12 })}
            alt={`${w.label}: ${percent(w.pct)} usado`}
            width={90}
            height={12}
          />
          <Text bold color={colorOf(w)}>
            {percent(w.pct)}
          </Text>
          <Text dimColor>
            dura {durationText(w)} · reset {w.resetsAt === undefined ? '—' : hours((w.msToReset ?? 0) / HOUR)}
          </Text>
        </Box>
      ))}
      <Text dimColor>
        {usageSummary(snap, totals, data.api)}
        {readingAge(snap.readAt, now) !== undefined && ` · leitura ${readingAge(snap.readAt, now)}`}
      </Text>
    </Box>
    {AdviceLine(ui, snap.advice, data.economy, actions)}
    </Box>
  )
}

// ---------- terminal ----------

/** Faixa acima do prompt no terminal: um item por limite, quebrando linha se faltar largura. */
export const TerminalBand = (ui: TerminalUi, { snap, totals, economy, api }: ViewData, actions: Actions) => {
  const { Box, Text } = ui

  return (
    <Box flexDirection="column">
    <Box flexDirection="row" columnGap={3} flexWrap="wrap">
      {snap.windows.map(w => (
        <Text key={w.kind}>
          <Text bold>{shortLabel(w.kind)}</Text> <Text color={colorOf(w)}>{bar(w.pct, 8)}</Text>{' '}
          <Text bold color={colorOf(w)}>
            {percent(w.pct)}
          </Text>{' '}
          <Text dimColor>
            dura {durationText(w)} · reset {w.resetsAt === undefined ? '—' : hours((w.msToReset ?? 0) / HOUR)}
          </Text>
        </Text>
      ))}
      <Text key="session" dimColor>
        {usageSummary(snap, totals, api)}
        {readingAge(snap.readAt, snap.updatedAt) !== undefined && ` · leitura ${readingAge(snap.readAt, snap.updatedAt)}`} · /limites
      </Text>
    </Box>
    {AdviceLine(ui, snap.advice, economy, { ...actions, details: undefined })}
    </Box>
  )
}

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
              {w.rateSource === 'work'
                ? `ritmo de trabalho ${rateText(w.ratePerHour)} por hora de uso · ${workDaysText(w) ?? ''}`
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
