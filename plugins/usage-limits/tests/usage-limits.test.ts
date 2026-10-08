import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addToMix, advise, emptyMix } from '../hooks/advisor'
import { HOUR, MINUTE, addSample, emptyTotals, project, projectName, projectShares, statusLine } from '../hooks/projection'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const iso = (t: number) => new Date(t).toISOString()

/** O que o engine responde por baixo dos plugins num teste. */
const engine = (on: On) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

test('projeção: ritmo da janela que esgota antes do reset', () => {
  // 2h de janela, 60% usado: 30%/h, faltam 3h → acaba em ~1h20.
  const w = project({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(NOW + 3 * HOUR) }, NOW)
  expect(w.verdict).toBe('exhausts')
  expect(w.rateSource).toBe('window')
  expect(Math.round(w.windowRatePerHour ?? 0)).toBe(30)
  expect(Math.round(((w.exhaustAt ?? 0) - NOW) / MINUTE)).toBe(80)
})

test('projeção: ritmo recente parado dura até o reset', () => {
  const resetsAt = NOW + 3 * HOUR
  let log = addSample(undefined, resetsAt, { t: NOW - 2 * HOUR, pct: 10 })
  log = addSample(log, resetsAt, { t: NOW - 90 * MINUTE, pct: 60 })
  const w = project({ kind: 'five_hour', percentUsed: 60, resetsAt: iso(resetsAt) }, NOW, log)
  expect(w.rateSource).toBe('recent')
  expect(w.recentRatePerHour).toBe(0)
  expect(w.verdict).toBe('ok')
})

test('projeção: semanal e tokens por 1%', () => {
  const resetsAt = NOW + 4 * 24 * HOUR
  const w = project({ kind: 'seven_day', percentUsed: 30, resetsAt: iso(resetsAt) }, NOW, undefined, {
    resetsAt,
    tokens: 2_000_000,
    firstPct: 10,
  })
  // 3 dias, 30% → 10%/dia; mais 4 dias → 70% no reset.
  expect(Math.round(w.pctAtReset ?? 0)).toBe(70)
  expect(w.verdict).toBe('ok')
  expect(w.tokensPerPct).toBe(100_000)
})

test('session.measure atualiza o estado, a linha de status e avisa', async ($, on) => {
  engine(on)
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))

  await $.session.measure({
    context: { window: 200_000, tokens: 50_000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85, resetsAt: iso(NOW + 3 * HOUR) },
      { kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 5 * 24 * HOUR) },
    ],
    changed: ['rateLimits'],
  })

  expect(statuses.at(-1)).toMatch(/^5h 85% dura ~0,4h ⚠ │ Sem 20% dura ~192h ✓ │ 0 tok$/)
  expect(toasts.some(t => t.includes('em 85%'))).toBe(true)
  expect(toasts.some(t => t.includes('No ritmo atual'))).toBe(true)

  // O mesmo nível não avisa de novo na mesma janela.
  const before = toasts.length
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: iso(NOW + 3 * HOUR) }],
    changed: ['rateLimits'],
  })
  expect(toasts.length).toBe(before)
})

test('turn.complete soma os tokens da sessão', async ($, on) => {
  engine(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 4 * HOUR) }],
    changed: ['rateLimits'],
  })

  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: {
      model: 'claude-opus-5-5',
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
    },
  })

  expect(statuses.at(-1)).toMatch(/│ 1\.4k tok$/)
})

test('linha de status mostra tokens, custo e duração em horas', () => {
  const w = project({ kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 4 * HOUR) }, NOW)
  // 1h de janela, 40% → 40%/h; faltam 60% → 1,5h.
  const totals = { ...emptyTotals(), input: 1000, output: 2000, cacheRead: 2_000_000 }
  expect(statusLine([w], totals, 3.456)).toBe('5h 40% dura ~1,5h ⚠ │ 2.0M tok · US$ 3,46')
})

const MEASURE = {
  context: { window: 200_000, tokens: 50_000, percent: 25 },
  cost: { usd: 3.21 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 60, resetsAt: iso(NOW + 3 * HOUR) },
    { kind: 'seven_day', percentUsed: 20, resetsAt: iso(NOW + 5 * 24 * HOUR) },
  ],
  changed: ['rateLimits', 'cost'] as ('rateLimits' | 'cost')[],
}

const PANE_PROPS = {
  title: 'Limites',
  isFocused: false,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

test('painel no desktop desenha cartões com SVG', async ($, on) => {
  engine(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({
    plugin: 'usage-limits',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'usage-limits',
    props: PANE_PROPS,
  })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)
  expect(await ui.find({ text: 'Duração estimada' })).toBeDefined()
  expect(await ui.find({ text: 'US$ 3,21' })).toBeDefined()
  expect(await ui.find({ text: /Apertado|Dura até|acaba/ })).toBeDefined()
  expect(await ui.find({ text: 'Qual modelo usar' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'economy-on' })).toBeDefined()
})

test('painel no terminal continua em texto', async ($, on) => {
  engine(on)
  await $.session.measure(MEASURE)
  const ui = await $.ui.mount({
    plugin: 'usage-limits',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'usage-limits',
    props: PANE_PROPS,
  })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ text: /duração estimada ~/ })).toBeDefined()
})

test('faixa acima do prompt: SVG e botão no desktop, texto no terminal', async ($, on) => {
  engine(on)
  // O que o engine desenharia sozinho na faixa: uma caixa vazia.
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)
  await $.session.measure(MEASURE)
  const props = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  }
  const desktop = await $.ui.mount({ plugin: 'usage-limits', surface: 'desktop', component: 'AbovePrompt', props })
  expect(await desktop.findAll({ type: 'Svg' })).toHaveLength(2)
  expect(await desktop.find({ type: 'Button', key: 'details' })).toBeDefined()

  const terminal = await $.ui.mount({ plugin: 'usage-limits', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await terminal.find({ type: 'Button', key: 'details' })).toBeUndefined()
  expect(await terminal.find({ text: /dura ~.* · reset 3,0h/ })).toBeDefined()
  expect(await terminal.find({ text: /US\$ 3,21 · \/limites/ })).toBeDefined()
})

const tok = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

test('recomendação: Opus orquestra e Haiku executa quando o semanal não chega ao reset', () => {
  const resetsAt = NOW + 4 * 24 * HOUR
  // 3 dias, 60% → 20%/dia; mais 4 dias → 140% no reset.
  const w = project({ kind: 'seven_day', percentUsed: 60, resetsAt: iso(resetsAt) }, NOW)
  expect(w.verdict).toBe('exhausts')
  let mix = emptyMix(resetsAt)
  mix = addToMix(mix, 'main', 'claude-opus-5-5', tok(100_000, 50_000, 2_000_000))
  mix = addToMix(mix, 'sub', 'claude-opus-5-5[1m]', tok(800_000, 300_000, 5_000_000))

  const a = advise([w], { seven_day: mix }, { mainModel: 'claude-opus-5-5', mainEffort: 'xhigh' })
  expect(a?.pick).toBe('sub-haiku')
  expect(a?.headline).toMatch(/use Opus 5\.5 para orquestrar e Haiku para executar/)
  expect(a?.headline).toMatch(/seu plano dura até o reset/)
  expect(a?.subModels).toEqual(['opus-5-5'])
  expect(a?.tip).toMatch(/effort high/)
  expect(a?.scenarios[0]?.lasts).toBe(true)
})

test('recomendação: sem subagentes sugere Sonnet no principal', () => {
  const resetsAt = NOW + 4 * 24 * HOUR
  // 3 dias, 45% → 15%/dia: ~105% no reset; em Sonnet o gasto cai ~45%.
  const w = project({ kind: 'seven_day', percentUsed: 45, resetsAt: iso(resetsAt) }, NOW)
  const mix = addToMix(emptyMix(resetsAt), 'main', 'claude-opus-5-5', tok(500_000, 200_000, 3_000_000))
  const a = advise([w], { seven_day: mix }, { mainModel: 'claude-opus-5-5' })
  expect(a?.pick).toBe('all-sonnet')
  expect(a?.headline).toMatch(/\/model sonnet/)
})

test('recomendação: no ritmo certo diz que o plano dura até o reset', () => {
  const resetsAt = NOW + 4 * 24 * HOUR
  const w = project({ kind: 'seven_day', percentUsed: 20, resetsAt: iso(resetsAt) }, NOW)
  const a = advise([w], {}, { mainModel: 'claude-opus-5-5' })
  expect(a?.isFine).toBe(true)
  expect(a?.pick).toBeUndefined()
  expect(a?.headline).toMatch(/^✓ Mantendo o uso atual, seu plano dura até o reset/)
})

const STEP = { turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 3 }

test('modo economia põe subagentes em Haiku e mantém o principal', async ($, on) => {
  engine(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const models: string[] = []
  on('turn.step', async function* ($, e) {
    models.push(e.model)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const run = async (input: typeof STEP & { agentId?: string }) => {
    const stream = $.turn.step(input)
    for await (const _ of stream) void _
    return stream.result
  }

  await run({ ...STEP, agentId: 'antes' })
  await $.command.run({
    command: 'economia',
    args: 'on',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  await run({ ...STEP, agentId: 'depois' })
  await run({ ...STEP, index: 1, agentId: 'antes' })
  await run(STEP)

  expect(models).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
})

test('orçamento por projeto: nome e divisão do gasto', () => {
  expect(projectName('/Users/kevinm/MMORPG')).toBe('MMORPG')
  expect(projectName('/Users/kevinm/Duel/.claude/worktrees/sad-kirch')).toBe('Duel')
  expect(projectName('C:\\dev\\Jogo\\workdir')).toBe('Jogo')
  const shares = projectShares({ resetsAt: 0, firstPct: 10, byProject: { MMORPG: 6, Enco: 3, MODS: 1 } }, 40)
  expect(shares.map(s => s.name)).toEqual(['MMORPG', 'Enco', 'MODS'])
  expect(shares[0]?.share).toBe(0.6)
  expect(shares[0]?.points).toBe(18)
})

test('semanal recém-começado: o ritmo é por dia, não pelas primeiras horas', () => {
  // Como na sessão real: 7% nas primeiras 5h de uma semana que reseta em 163h.
  const w = project({ kind: 'seven_day', percentUsed: 7, resetsAt: iso(NOW + 163 * HOUR) }, NOW)
  expect(Math.round(w.pctAtReset ?? 0)).toBe(55)
  expect(w.verdict).toBe('ok')
  const fiveHour = project({ kind: 'five_hour', percentUsed: 26, resetsAt: iso(NOW + 1.6 * HOUR) }, NOW)
  expect(Math.round(fiveHour.hoursLeft ?? 0)).toBe(10)
})
