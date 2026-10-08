import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage, TurnUsage } from 'claude-code'

import type { Advice, ApiSpend, Mix, ProjectBucket, SessionRecord, Snapshot, Totals, WindowView } from '../types'
import { apiProblem, costReportUrl, cycleBounds, projectApi, sumCostReport } from './api'
import { sessionsView, upsertSession } from './sessions'
import type { SessionBook } from './sessions'
import { addToMix, advise, emptyMix } from './advisor'
import { activeHoursPerDay, addActivity, addHourly, recentMix, updateCalibration, weekPerFive } from './pace'
import type { Calibration, HourlyMix } from './pace'
import { HAIKU_ID, costOf, family, modelKey } from './pricing'
import {
  addSample,
  apiShort,
  clockTime,
  duration,
  emptyTotals,
  percent,
  project,
  projectName,
  projectShares,
  readingAge,
  sameWindow,
  statusLine,
  totalTokens,
} from './projection'
import type { SampleLog, TokenBucket } from './projection'
import { RichBand, RichPane, TerminalBand, TerminalPane } from './view'
import type { Actions, ViewData } from './view'

const PANE = 'usage-limits'
const COMMAND = 'limites'
const ECONOMY_COMMAND = 'economia'

const snapshot = atom({ plugin: 'usage-limits', key: 'snapshot' } as const, null)
const session = atom({ plugin: 'usage-limits', key: 'session' } as const, emptyTotals())
const economy = atom({ plugin: 'usage-limits', key: 'economy' } as const, false)
const setup = atom({ plugin: 'usage-limits', key: 'setup' } as const, {})
const currentProject = atom({ plugin: 'usage-limits', key: 'project' } as const, '')
const api = atom({ plugin: 'usage-limits', key: 'api' } as const, null)

type Alerts = { resetsAt: number; sent: string[] }

const samplesKey = (kind: string) => `samples:${kind}`
const bucketKey = (kind: string) => `tokens:${kind}`
const alertsKey = (kind: string) => `alerts:${kind}`
const mixKey = (kind: string) => `mix:${kind}`
const projectsKey = (kind: string) => `projects:${kind}`
const ECONOMY_KEY = 'economy'
const CALIBRATION_KEY = 'calibration'
const ACTIVITY_KEY = 'activity'
const HOURLY_KEY = 'hourly'
const WORK_RATE_KEY = 'lastWorkRate'

/** A leitura desta sessão e os arquivos que as sessões da máquina compartilham. */
const reading = { ownAt: 0, own: [] as SessionRateLimit[], sharedFile: '', sessionsFile: '', selfId: '', startedAt: 0 }

/** As opções dos créditos de API, do /plugin. */
const apiConfig = { key: '', creditUsd: 200, cycleDay: 1 }

const readBook = async ($: EngineInterface): Promise<SessionBook | undefined> => {
  if (!reading.sessionsFile) return undefined
  try {
    if (!(await $.fs.exists(reading.sessionsFile))) return undefined
    const raw = JSON.parse(await $.fs.read(reading.sessionsFile)) as Record<string, unknown>
    const book: SessionBook = {}
    for (const [id, r] of Object.entries(raw ?? {})) {
      const rec = r as Partial<SessionRecord> | null
      if (rec && typeof rec === 'object' && rec.id === id && typeof rec.updatedAt === 'number' && rec.tokens) {
        book[id] = rec as SessionRecord
      }
    }
    return book
  } catch {
    return undefined
  }
}

/** Grava o consumo desta sessão no livro de sessões da máquina e devolve o livro. */
const writeSelf = async ($: EngineInterface, costUsd: number | undefined, ended = false) => {
  if (!reading.sessionsFile || !reading.selfId) return undefined
  const now = await $.clock.now()
  const held = await readBook($)
  const previous = held?.[reading.selfId]
  const record: SessionRecord = {
    id: reading.selfId,
    project: await read($, currentProject),
    model: (await read($, setup)).mainModel,
    startedAt: reading.startedAt || now,
    updatedAt: now,
    tokens: await read($, session),
    costUsd: costUsd ?? previous?.costUsd ?? 0,
    ended,
  }
  const book = upsertSession(held, record, now)
  try {
    await $.fs.write(reading.sessionsFile, JSON.stringify(book))
  } catch {
    // Sem o arquivo, a lista mostra só esta sessão.
  }

  return book
}

/** Lê do Console quanto dos créditos de API o ciclo já gastou. */
const refreshApi = async ($: EngineInterface) => {
  if (!apiConfig.key) return
  const now = await $.clock.now()
  const bounds = cycleBounds(now, apiConfig.cycleDay)
  let usdTotal = 0
  const byModel: Record<string, number> = {}
  let page: string | undefined
  try {
    for (let i = 0; i < 5; i++) {
      const r = await $.http.fetch(costReportUrl(bounds.start, now, page), {
        headers: { 'x-api-key': apiConfig.key, 'anthropic-version': '2023-06-01', 'user-agent': 'usage-limits-mod/0.5' },
      })
      if (!r.ok) {
        const held = await read($, api)
        await update($, api, () => ({ ...(held ?? projectApi(0, {}, bounds, now, apiConfig.creditUsd)), problem: apiProblem(r.status, r.text) }))
        return
      }
      const pageSum = sumCostReport(r.text)
      usdTotal += pageSum.usd
      for (const [m, v] of Object.entries(pageSum.byModel)) byModel[m] = (byModel[m] ?? 0) + v
      page = pageSum.next
      if (!page) break
    }
    await update($, api, () => projectApi(usdTotal, byModel, bounds, now, apiConfig.creditUsd))
  } catch (error) {
    const held = await read($, api)
    await update($, api, () => ({
      ...(held ?? projectApi(0, {}, bounds, now, apiConfig.creditUsd)),
      problem: `Não consegui falar com o Console: ${String(error).slice(0, 120)}`,
    }))
  }
}

const apiStatus = (spend: ApiSpend | null) => (spend && !spend.problem ? apiShort(spend.spentUsd, spend.creditUsd) : undefined)

type SharedReading = { at: number; rateLimits: SessionRateLimit[] }

const readShared = async ($: EngineInterface): Promise<SharedReading | undefined> => {
  if (!reading.sharedFile) return undefined
  try {
    if (!(await $.fs.exists(reading.sharedFile))) return undefined
    const data = JSON.parse(await $.fs.read(reading.sharedFile)) as Partial<SharedReading>
    return typeof data.at === 'number' && Array.isArray(data.rateLimits) ? (data as SharedReading) : undefined
  } catch {
    return undefined
  }
}

const writeShared = async ($: EngineInterface, value: SharedReading) => {
  if (!reading.sharedFile) return
  try {
    await $.fs.write(reading.sharedFile, JSON.stringify(value))
  } catch {
    // Sem arquivo compartilhado, cada sessão segue com a própria leitura.
  }
}

const resetOf = (w: SessionRateLimit) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)

const loadMix = async ($: EngineInterface, w: WindowView): Promise<Mix | undefined> => {
  const held = (await $.store.get(mixKey(w.kind))) as Mix | undefined

  return held && w.resetsAt !== undefined && sameWindow(held.resetsAt, w.resetsAt) ? held : undefined
}

/**
 * Recalcula tudo a partir da leitura mais nova da máquina: a desta sessão ou a
 * que outra sessão gravou no arquivo compartilhado. `record` diz que a leitura
 * desta sessão acabou de mudar.
 */
const refresh = async ($: EngineInterface, usage: SessionUsage, record: boolean) => {
  const now = await $.clock.now()
  if (record && usage.rateLimits.length > 0) {
    reading.ownAt = now
    reading.own = usage.rateLimits
    await writeShared($, { at: now, rateLimits: usage.rateLimits })
    const five = usage.rateLimits.find(w => w.kind === 'five_hour')
    const week = usage.rateLimits.find(w => w.kind === 'seven_day')
    if (five && week) {
      const held = (await $.store.get(CALIBRATION_KEY)) as Calibration | undefined
      const next = updateCalibration(held, five, week)
      if (next) await $.store.set(CALIBRATION_KEY, next)
    }
  }

  let limits = reading.own.length > 0 ? reading.own : usage.rateLimits
  let readAt: number | undefined = reading.ownAt || undefined
  let isShared = false
  const shared = await readShared($)
  if (shared && shared.rateLimits.length > 0 && shared.at > (reading.ownAt || 0) + 30_000) {
    limits = shared.rateLimits
    readAt = shared.at
    isShared = true
  }
  // O 5h primeiro: o ritmo dele alimenta o do semanal.
  const ordered = [...limits].sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))

  const perDay = activeHoursPerDay((await $.store.get(ACTIVITY_KEY)) as number[] | undefined, now)
  const ratio = weekPerFive((await $.store.get(CALIBRATION_KEY)) as Calibration | undefined)
  const lastWorkRate = (await $.store.get(WORK_RATE_KEY)) as number | undefined
  let fiveRate: number | undefined
  const windows: WindowView[] = []
  const mixes: Record<string, Mix | undefined> = {}

  for (const raw of ordered) {
    const resetsAt = resetOf(raw)
    let log = (await $.store.get(samplesKey(raw.kind))) as SampleLog | undefined
    if ((record || isShared) && !Number.isNaN(resetsAt)) {
      log = addSample(log, resetsAt, { t: readAt ?? now, pct: raw.percentUsed })
      await $.store.set(samplesKey(raw.kind), log)
    }
    const bucket = (await $.store.get(bucketKey(raw.kind))) as TokenBucket | undefined
    const view = project(raw, now, log, bucket, { fiveRate, weekPerFive: ratio, lastWorkRate, activeHoursPerDay: perDay })
    if (raw.kind === 'five_hour') {
      const recent = view.recentRatePerHour ?? 0
      fiveRate = recent > 0 ? recent : (view.windowRatePerHour ?? 0) > 0 ? view.windowRatePerHour : undefined
    }
    if (view.rateSource === 'work' && ratio !== undefined && fiveRate !== undefined && view.ratePerHour !== undefined) {
      await $.store.set(WORK_RATE_KEY, view.ratePerHour)
    }
    windows.push(view)
    mixes[raw.kind] = await loadMix($, view)
    const projects = (await $.store.get(projectsKey(raw.kind))) as ProjectBucket | undefined
    if (projects && view.resetsAt !== undefined && sameWindow(projects.resetsAt, view.resetsAt)) {
      view.projects = projectShares(projects, view.pct)
    }
  }

  const recent = recentMix((await $.store.get(HOURLY_KEY)) as HourlyMix | undefined, now, 0)
  const book = await writeSelf($, usage.cost?.usd)
  const sessions = reading.selfId ? sessionsView(book, now, reading.selfId) : undefined
  const next: Snapshot = {
    updatedAt: now,
    windows,
    costUsd: usage.cost?.usd,
    contextPercent: usage.context.percent,
    advice: advise(windows, mixes, await read($, setup), recent),
    readAt,
    isSharedReading: isShared,
    sessions,
    selfId: reading.selfId,
  }
  await update($, snapshot, () => next)
  $.ui.status(
    statusLine(windows, await read($, session), next.costUsd, readingAge(readAt, now), {
      sessions: sessions && {
        count: sessions.total.count,
        tokens: totalTokens(sessions.total.tokens),
        costUsd: sessions.total.costUsd,
      },
      api: apiStatus(await read($, api)),
    }),
  )
  await alert($, windows, now, next.advice)
}

/** Avisa uma vez por janela em cada nível, e uma vez por recomendação. */
const alert = async ($: EngineInterface, windows: WindowView[], now: number, advice?: Advice) => {
  for (const w of windows) {
    if (w.resetsAt === undefined) continue
    const stored = (await $.store.get(alertsKey(w.kind))) as Alerts | undefined
    const held = stored && sameWindow(stored.resetsAt, w.resetsAt) ? stored.sent : []
    const sent = [...held]
    const once = (level: string, text: string) => {
      if (sent.includes(level)) return
      sent.push(level)
      $.ui.toast(text, { timeoutMs: 8000 })
    }

    if (w.verdict === 'exhausted') {
      once('100', `Limite ${w.label} esgotado. Volta às ${clockTime(w.resetsAt, now)}.`)
    } else if (w.pct >= 95) {
      once('95', `Limite ${w.label} em ${percent(w.pct)}. Reset às ${clockTime(w.resetsAt, now)}.`)
    } else if (w.pct >= 80) {
      once('80', `Limite ${w.label} em ${percent(w.pct)}. Reset às ${clockTime(w.resetsAt, now)}.`)
    }
    if (w.verdict === 'exhausts' && w.exhaustAt !== undefined && w.pct >= 25) {
      once(
        'projection',
        `No ritmo atual o limite ${w.label} acaba ~${clockTime(w.exhaustAt, now)}, ` +
          `${duration(w.resetsAt - w.exhaustAt)} antes do reset.`,
      )
    }
    if (advice?.pick && advice.windowKind === w.kind && w.pct >= 15) {
      once(`advice:${advice.pick}`, `${advice.headline} Veja /limites.`)
    }

    if (sent.length !== held.length) {
      await $.store.set(alertsKey(w.kind), { resetsAt: w.resetsAt, sent })
    }
  }
}

/** Soma os tokens de uma resposta às janelas abertas. */
const countTokens = async ($: EngineInterface, tokens: number) => {
  const last = await read($, snapshot)
  for (const w of last?.windows ?? []) {
    if (w.resetsAt === undefined) continue
    const held = (await $.store.get(bucketKey(w.kind))) as TokenBucket | undefined
    const bucket: TokenBucket =
      held && sameWindow(held.resetsAt, w.resetsAt)
        ? { ...held, tokens: held.tokens + tokens }
        : { resetsAt: w.resetsAt, tokens, firstPct: w.pct }
    await $.store.set(bucketKey(w.kind), bucket)
  }
}

/** Soma uma resposta ao gasto por modelo e por papel de cada janela aberta. */
const countMix = async ($: EngineInterface, role: 'main' | 'sub', usage: TurnUsage) => {
  const last = await read($, snapshot)
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  for (const w of last?.windows ?? []) {
    if (w.resetsAt === undefined) continue
    const held = (await loadMix($, w)) ?? emptyMix(w.resetsAt)
    await $.store.set(mixKey(w.kind), addToMix(held, role, usage.model, tokens))
  }
}

/** Anota a hora de trabalho e soma a resposta ao gasto por hora (para a recomendação). */
const countRecent = async ($: EngineInterface, role: 'main' | 'sub', usage: TurnUsage) => {
  const now = await $.clock.now()
  await $.store.set(ACTIVITY_KEY, addActivity((await $.store.get(ACTIVITY_KEY)) as number[] | undefined, now))
  const tokens = {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  }
  const held = (await $.store.get(HOURLY_KEY)) as HourlyMix | undefined
  await $.store.set(HOURLY_KEY, addHourly(held, now, role, modelKey(usage.model), tokens))
}

/** Soma o custo de uma resposta ao projeto da sessão em cada janela aberta. */
const countProject = async ($: EngineInterface, usage: TurnUsage) => {
  const name = await read($, currentProject)
  const last = await read($, snapshot)
  if (!name) return
  const cost = costOf(
    {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
    },
    modelKey(usage.model),
  )
  for (const w of last?.windows ?? []) {
    if (w.resetsAt === undefined) continue
    const held = (await $.store.get(projectsKey(w.kind))) as ProjectBucket | undefined
    const bucket: ProjectBucket =
      held && sameWindow(held.resetsAt, w.resetsAt) ? held : { resetsAt: w.resetsAt, firstPct: w.pct, byProject: {} }
    bucket.byProject[name] = (bucket.byProject[name] ?? 0) + cost
    await $.store.set(projectsKey(w.kind), bucket)
  }
}

/** Raiz do git da pasta da sessão, ou a própria pasta. */
const findProject = async ($: EngineInterface, cwd: string) => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    return projectName(exitCode === 0 && stdout.trim() ? stdout.trim() : cwd)
  } catch {
    return projectName(cwd)
  }
}

const setEconomy = async ($: EngineInterface, on: boolean) => {
  await update($, economy, () => on)
  await $.store.set(ECONOMY_KEY, on)
  $.ui.toast(
    on
      ? 'Modo economia ligado: o fio principal orquestra, os novos subagentes executam em Haiku 5.5.'
      : 'Modo economia desligado: os subagentes voltam ao modelo de sempre.',
  )
}

/**
 * O botão ↻: relê a leitura mais nova da máquina, recalcula, atualiza a lista
 * de sessões e os créditos de API. O % da conta em si só muda quando alguma
 * sessão recebe uma resposta da API (uma chamada avulsa não o traz).
 */
const reloadAll = async ($: EngineInterface) => {
  if (apiConfig.key) await refreshApi($)
  await refresh($, await $.session.usage(), false)
  const age = readingAge((await read($, snapshot))?.readAt, await $.clock.now())
  $.ui.toast(
    age
      ? `Atualizado. A leitura da conta é de ${age}; um número novo chega na próxima resposta do Claude em qualquer sessão desta máquina.`
      : 'Atualizado com a leitura mais recente da conta.',
    { timeoutMs: 6000 },
  )
}

const actionsFor = ($: EngineInterface, withDetails: boolean): Actions => ({
  details: withDetails ? () => void $.ui.open({ id: PANE, title: 'Limites' }) : undefined,
  reload: () => void reloadAll($),
  toggleEconomy: () => void read($, economy).then(on => setEconomy($, !on)),
  fillModel: alias => void $.prompt.fill({ text: `/model ${alias}` }),
})

const viewData = async ($: EngineInterface, snap: Snapshot): Promise<ViewData> => ({
  snap,
  totals: await read($, session),
  economy: await read($, economy),
  api: await read($, api),
})

export const register: Register = (on, options) => {
  apiConfig.key = String(options.adminApiKey ?? '').trim()
  apiConfig.creditUsd = Number(options.apiMonthlyCredit ?? 200)
  apiConfig.cycleDay = Number(options.apiCycleDay ?? 1)

  /** Subagentes já decididos: true roda em Haiku. Um agente nunca troca no meio. */
  const haikuAgents = new Map<string, boolean>()
  const forks = new Set<string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const dir = home ? `${home.replaceAll('\\', '/')}/.claude/usage-limits` : ''
    reading.sharedFile = dir ? `${dir}/latest.json` : ''
    reading.sessionsFile = dir ? `${dir}/sessions.json` : ''
    reading.selfId = await $.session.id()
    reading.startedAt = (await $.session.usage()).startedAt
    const name = await findProject($, started.cwd)
    await update($, currentProject, () => name)
    await $.command.register({
      name: COMMAND,
      description: 'Mostra consumo de tokens, previsão dos limites e qual modelo usar',
    })
    await $.command.register({
      name: ECONOMY_COMMAND,
      description: 'Liga/desliga o modo economia: o principal orquestra, subagentes executam em Haiku',
    })
    const isEconomy = (await $.store.get(ECONOMY_KEY)) === true
    await update($, economy, () => isEconomy)
    await refresh($, await $.session.usage(), false)
    $.clock.every(60_000, () => {
      void $.session.usage().then(usage => refresh($, usage, false))
    })
    if (apiConfig.key) {
      void refreshApi($)
      $.clock.every(10 * 60_000, () => void refreshApi($))
    }

    return started
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await refresh($, { startedAt: 0, ...e }, e.changed.includes('rateLimits'))

    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (e.fork && result.agentId) forks.add(result.agentId)

    return result
  })

  // Cada chamada ao modelo: anota o modelo principal, põe subagentes em Haiku
  // no modo economia e soma o gasto por modelo e papel.
  on('turn.step', async function* ($, e, next) {
    let step = e
    if (e.agentId) {
      let isHaiku = haikuAgents.get(e.agentId)
      if (isHaiku === undefined) {
        isHaiku = e.index === 0 && !forks.has(e.agentId) && (await read($, economy))
        haikuAgents.set(e.agentId, isHaiku)
      }
      if (isHaiku && family(modelKey(e.model)) !== 'haiku') step = { ...e, model: HAIKU_ID }
    } else {
      const held = await read($, setup)
      if (held.mainModel !== e.model || held.mainEffort !== e.effort) {
        const effort = typeof e.effort === 'number' ? String(e.effort) : e.effort
        await update($, setup, () => ({ mainModel: e.model, mainEffort: effort }))
      }
    }

    const result = yield* next(step)
    if (result.usage) {
      await countMix($, e.agentId ? 'sub' : 'main', result.usage)
      await countProject($, result.usage)
      await countRecent($, e.agentId ? 'sub' : 'main', result.usage)
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    if (usage) {
      const add: Totals = {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        turns: e.agentId ? 0 : 1,
      }
      const totals = await update($, session, t => ({
        input: t.input + add.input,
        output: t.output + add.output,
        cacheRead: t.cacheRead + add.cacheRead,
        cacheWrite: t.cacheWrite + add.cacheWrite,
        turns: t.turns + add.turns,
      }))
      await countTokens($, totalTokens(add))
      const last = await read($, snapshot)
      await writeSelf($, last?.costUsd)
      $.ui.status(
        statusLine(last?.windows ?? [], totals, last?.costUsd, readingAge(last?.readAt, await $.clock.now()), {
          api: apiStatus(await read($, api)),
        }),
      )
    }

    return result
  })

  // Ao fechar: marca a sessão como encerrada na lista da máquina (dentro do tempo curto do fim).
  on('session.end', async ($, e, next) => {
    try {
      await writeSelf($, (await read($, snapshot))?.costUsd, true)
    } catch {
      // O fim da sessão não espera pelo mod.
    }
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    if (apiConfig.key) void refreshApi($)
    await refresh($, await $.session.usage(), false)
    await $.ui.open({ id: PANE, title: 'Limites' })

    return { text: 'Painel de limites aberto.' }
  })

  on('command.run', { command: ECONOMY_COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = arg === 'on' || arg === 'ligar' ? true : arg === 'off' || arg === 'desligar' ? false : !(await read($, economy))
    await setEconomy($, isOn)
    await refresh($, await $.session.usage(), false)

    return {
      text: isOn
        ? 'Modo economia ligado: novos subagentes rodam em Haiku 5.5; o fio principal continua no modelo atual.'
        : 'Modo economia desligado.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const snap = await read($, snapshot)
    if (e.surface === 'terminal') {
      const ui = $.ui.resolve(e)
      if (snap === null) return <ui.Text dimColor>Aguardando a primeira leitura…</ui.Text>

      return TerminalPane(ui, await viewData($, snap), e.props.bodyColumns, actionsFor($, false))
    }
    const ui = $.ui.resolve(e)
    if (snap === null) return <ui.Text dimColor>Aguardando a primeira leitura…</ui.Text>

    return RichPane(ui, await viewData($, snap), e.props.bodyColumns, actionsFor($, false))
  })

  // Faixa acima do prompt: barras SVG no desktop, texto no terminal.
  // Empilha sobre o que outros plugins desenham na faixa, em vez de substituir.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const snap = await read($, snapshot)
    if (snap === null || snap.windows.length === 0) return below
    const data = await viewData($, snap)
    if (e.surface === 'terminal') {
      const ui = $.ui.resolve(e)
      return (
        <ui.Box flexDirection="column">
          {TerminalBand(ui, data, actionsFor($, true))}
          {below}
        </ui.Box>
      )
    }
    if (e.surface !== 'desktop') return below
    const ui = $.ui.resolve(e)

    return (
      <ui.Box flexDirection="column">
        {RichBand(ui, data, actionsFor($, true))}
        {below}
      </ui.Box>
    )
  })
}
