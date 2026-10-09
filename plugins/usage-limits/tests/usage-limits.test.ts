import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { addToMix, advise, emptyMix } from '../hooks/advisor'
import { activeHoursPerDay, addActivity, addHourly, recentMix, updateCalibration, weekPerFive } from '../hooks/pace'
import { costReportUrl, cycleBounds, projectApi, sumCostReport } from '../hooks/api'
import { sessionsView, upsertSession } from '../hooks/sessions'
import type { Calibration } from '../hooks/pace'
import { HOUR, MINUTE, addSample, emptyTotals, project, projectName, projectShares, statusLine, statusPart } from '../hooks/projection'

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

const reading = (p5: number, pWeek: number) => ({
  five: { kind: 'five_hour', percentUsed: p5, resetsAt: iso(NOW + 1.6 * HOUR) },
  week: { kind: 'seven_day', percentUsed: pWeek, resetsAt: iso(NOW + 163 * HOUR) },
})

test('calibração com as leituras reais da manhã: 1 ponto semanal a cada 4 do 5h', () => {
  let c: Calibration | undefined
  for (const [p5, pw] of [[19, 5], [22, 6], [25, 7], [27, 7]] as const) {
    const r = reading(p5, pw)
    c = updateCalibration(c, r.five, r.week)
  }
  expect(c?.sum5).toBe(8)
  expect(c?.sumWeek).toBe(2)
  expect(weekPerFive(c)).toBe(0.25)
  // Entre janelas de 5h nada é somado: o fim da janela anterior não foi visto.
  const next = updateCalibration(c, { kind: 'five_hour', percentUsed: 3, resetsAt: iso(NOW + 6 * HOUR) }, reading(0, 8).week)
  expect(next?.sum5).toBe(8)
  expect(next?.sumWeek).toBe(2)
})

test('regressão 09/10: noite com o 5h resetando não corrompe a calibração', () => {
  // Ontem 22:24: 5h em 18%, semanal 33%. Hoje 07:19: janela de 5h nova em 1%, semanal 42%.
  let c: Calibration | undefined
  for (const [p5, pw] of [[10, 30], [14, 31], [18, 33]] as const) {
    c = updateCalibration(c, { kind: 'five_hour', percentUsed: p5, resetsAt: iso(NOW - 2 * HOUR) }, reading(0, pw).week)
  }
  c = updateCalibration(c, { kind: 'five_hour', percentUsed: 1, resetsAt: iso(NOW + 5 * HOUR) }, reading(0, 42).week)
  expect(c?.sum5).toBe(8)
  expect(c?.sumWeek).toBe(3)
  expect(weekPerFive(c)).toBe(0.375)
  // Uma calibração antiga (sem versão) recomeça; uma razão absurda é descartada.
  expect(weekPerFive({ weekResetsAt: 0, sum5: 3, sumWeek: 34 })).toBeUndefined()
  expect(weekPerFive({ v: 2, weekResetsAt: 0, sum5: 6, sumWeek: 34 })).toBeUndefined()
})

test('regressão 09/10: semanal em 43% depois de 27h segue o ritmo da conta', () => {
  const now = Date.parse('2026-10-09T10:19:00Z')
  const week = { kind: 'seven_day', percentUsed: 43, resetsAt: '2026-10-15T07:00:00Z' }
  const w = project(week, now, undefined, undefined, { fiveRate: 2, weekPerFive: 0.265, activeHoursPerDay: 8 })
  expect(w.rateSource).toBe('window')
  expect(Math.round((w.ratePerHour ?? 0) * 24)).toBe(38)
  expect(Math.round(w.hoursLeft ?? 0)).toBe(36)
  expect(w.verdict).toBe('exhausts')
  expect(statusPart(w)).toBe('Sem 43% dura ~36h ⚠')
  // O extra: horas de uso no ritmo da última hora.
  expect(Math.round(w.workHoursLeft ?? 0)).toBe(108)
})

test('horas de uso no ritmo da última hora reagem à troca de Opus para Haiku', () => {
  const week = { kind: 'seven_day', percentUsed: 7, resetsAt: iso(NOW + 163 * HOUR) }
  // Opus executando: o 5h anda 8%/h → semanal 2%/h de uso.
  const opus = project(week, NOW, undefined, undefined, { fiveRate: 8, weekPerFive: 0.25, activeHoursPerDay: 8 })
  expect(Math.round(opus.workHoursLeft ?? 0)).toBe(47)
  // Haiku executando: o 5h passa a 1,5%/h.
  const haiku = project(week, NOW, undefined, undefined, { fiveRate: 1.5, weekPerFive: 0.25, activeHoursPerDay: 8 })
  expect(Math.round(haiku.workHoursLeft ?? 0)).toBe(248)
  // A projeção até o reset é a da conta, igual nos dois casos.
  expect(opus.pctAtReset).toBe(haiku.pctAtReset)
  // Sem calibração: sem o extra.
  expect(project(week, NOW, undefined, undefined, { fiveRate: 8, activeHoursPerDay: 8 }).workHoursLeft).toBeUndefined()
})

test('horas de trabalho por dia', () => {
  const h = (hoursAgo: number) => NOW - hoursAgo * HOUR
  let list: number[] | undefined
  for (const ago of [5, 4, 3, 1]) list = addActivity(list, h(ago))
  expect(activeHoursPerDay(list, NOW)).toBe(8)
  // Três dias, 6 horas por dia.
  let days: number[] | undefined
  for (const d of [0, 1, 2]) for (const k of [0, 1, 2, 3, 4, 5]) days = addActivity(days, NOW - d * 24 * HOUR - k * HOUR)
  expect(activeHoursPerDay(days, NOW)).toBe(6)
})

test('recomendação usa o gasto das últimas horas: depois da troca para Haiku não pede Haiku de novo', () => {
  const t = tok(500_000, 200_000, 4_000_000)
  let hourly = addHourly(undefined, NOW - 6 * HOUR, 'sub', 'opus-5-5', t)
  hourly = addHourly(hourly, NOW - 6 * HOUR, 'main', 'opus-5-5', tok(50_000, 20_000, 400_000))
  for (const ago of [2, 1, 0]) {
    hourly = addHourly(hourly, NOW - ago * HOUR, 'main', 'opus-5-5', tok(50_000, 20_000, 400_000))
    hourly = addHourly(hourly, NOW - ago * HOUR, 'sub', 'haiku-5-5', t)
  }
  const recent = recentMix(hourly, NOW, 0)
  expect(Object.keys(recent?.sub ?? {})).toEqual(['haiku-5-5'])

  const week = project({ kind: 'seven_day', percentUsed: 60, resetsAt: iso(NOW + 4 * 24 * HOUR) }, NOW)
  let windowMix = addToMix(emptyMix(NOW + 4 * 24 * HOUR), 'sub', 'claude-opus-5-5', t)
  windowMix = addToMix(windowMix, 'main', 'claude-opus-5-5', tok(50_000, 20_000, 400_000))
  const before = advise([week], { seven_day: windowMix }, { mainModel: 'claude-opus-5-5' })
  const after = advise([week], { seven_day: windowMix }, { mainModel: 'claude-opus-5-5' }, recent)
  expect(before?.pick).toBe('sub-haiku')
  expect(after?.mixBasis).toBe('recent')
  expect(after?.subModels).toEqual(['haiku-5-5'])
  expect(after?.pick).not.toBe('sub-haiku')
})

test('sessão parada usa a leitura mais nova que outra sessão gravou e mostra a idade', async ($, on) => {
  engine(on)
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/Users/k' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const shared = {
    at: NOW - 20 * MINUTE,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 40, resetsAt: iso(NOW + 3 * HOUR) },
      { kind: 'seven_day', percentUsed: 12, resetsAt: iso(NOW + 5 * 24 * HOUR) },
    ],
  }
  on('fs.exists', ($, e) => ({ value: e.path === '/Users/k/.claude/usage-limits/latest.json' }))
  on('fs.read', () => ({ value: JSON.stringify(shared) }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'sessao-a' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 10, resetsAt: iso(NOW + 3 * HOUR) }],
    },
  }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toMatch(/^5h 40% .* │ Sem 12% .* │ leitura há 20min │ 0 tok$/)
})

const rec = (id: string, project: string, costUsd: number, minutesAgo: number, ended = false) => ({
  id,
  project,
  model: 'claude-opus-5-5',
  startedAt: NOW - 3 * HOUR,
  updatedAt: NOW - minutesAgo * MINUTE,
  tokens: { input: 1000, output: 2000, cacheRead: 1_000_000, cacheWrite: 0, turns: 3 },
  costUsd,
  ended,
})

test('lista as sessões abertas, o total delas e o total de hoje', () => {
  let book = upsertSession(undefined, { ...rec('velha', 'x', 9, 0), updatedAt: NOW - 3 * 24 * HOUR }, NOW - 3 * 24 * HOUR)
  book = upsertSession(book, rec('a', 'MMORPG', 4, 0), NOW)
  book = upsertSession(book, rec('b', 'licitacao', 6, 1), NOW)
  book = upsertSession(book, rec('c', 'MODS', 2, 30), NOW) // sem sinal há 30 min: fechada
  book = upsertSession(book, rec('d', 'Duel', 1, 5, true), NOW) // encerrada
  expect(Object.keys(book).sort()).toEqual(['a', 'b', 'c', 'd'])

  const view = sessionsView(book, NOW, 'a')
  expect(view.running.map(r => r.id)).toEqual(['a', 'b'])
  expect(view.total.count).toBe(2)
  expect(view.total.costUsd).toBe(10)
  expect(view.today.count).toBe(4)
  expect(view.today.costUsd).toBe(13)
})

test('créditos de API: ciclo, soma do relatório do Console e projeção', () => {
  const now = new Date(2026, 9, 20, 12).getTime() // 20/10 12h
  const b = cycleBounds(now, 7)
  expect(new Date(b.start).getDate()).toBe(7)
  expect(new Date(b.end).getMonth()).toBe(10)
  const early = cycleBounds(new Date(2026, 9, 3).getTime(), 7)
  expect(new Date(early.start).getMonth()).toBe(8) // ainda no ciclo que começou em setembro

  const page = JSON.stringify({
    data: [
      { starting_at: '2026-10-07T00:00:00Z', results: [
        { amount: '1250.5', currency: 'USD', model: 'claude-haiku-5-5', description: 'Claude Haiku 5.5 Usage - Input Tokens' },
        { amount: '300', currency: 'USD', model: 'claude-haiku-5-5', description: 'Claude Haiku 5.5 Usage - Output Tokens' },
      ] },
      { starting_at: '2026-10-08T00:00:00Z', results: [] },
      { starting_at: '2026-10-09T00:00:00Z', results: [
        { amount: '449.5', currency: 'USD', model: null, description: 'Web Search Usage' },
      ] },
    ],
    has_more: false,
    next_page: null,
  })
  const sum = sumCostReport(page)
  expect(sum.usd).toBe(20)
  expect(sum.byModel['claude-haiku-5-5']).toBe(15.505)
  expect(sum.byModel['Web Search']).toBe(4.495)

  const spend = projectApi(sum.usd, sum.byModel, b, now, 200)
  expect(Math.round(spend.dailyUsd * 100) / 100).toBe(1.48)
  expect(spend.runsOutAt).toBeUndefined()
  const heavy = projectApi(150, {}, b, now, 200)
  expect(heavy.runsOutAt).toBeDefined()
  expect(costReportUrl(b.start, now)).toContain('/v1/organizations/cost_report?starting_at=')
  expect(costReportUrl(b.start, now)).toContain('group_by[]=description')
})

test('botão ↻ Atualizar na faixa e no painel, nas duas superfícies', async ($, on) => {
  engine(on)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)
  const toasts: string[] = []
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  let usageCalls = 0
  on('session.usage', () => {
    usageCalls += 1
    return { value: { startedAt: 0, context: { window: 200_000 }, rateLimits: MEASURE.rateLimits } }
  })
  await $.session.measure(MEASURE)

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({
      plugin: 'usage-limits',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    })
    expect(await band.find({ type: 'Button', key: 'reload' })).toBeDefined()
    const pane = await $.ui.mount({ plugin: 'usage-limits', surface, component: 'Pane', requestId: 'usage-limits', props: PANE_PROPS })
    expect(await pane.find({ type: 'Button', key: 'reload-top' })).toBeDefined()
  }

  const band = await $.ui.mount({
    plugin: 'usage-limits',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  await band.press({ key: 'reload' })
  expect(usageCalls).toBeGreaterThan(0)
  expect(toasts.at(-1)).toMatch(/^Atualizado/)
})
