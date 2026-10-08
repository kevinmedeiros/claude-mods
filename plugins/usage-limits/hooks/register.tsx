import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, SessionUsage, TurnUsage } from 'claude-code'

import type { Advice, Mix, ProjectBucket, Snapshot, Totals, WindowView } from '../types'
import { addToMix, advise, emptyMix } from './advisor'
import { HAIKU_ID, costOf, family, modelKey } from './pricing'
import {
  addSample,
  clockTime,
  duration,
  emptyTotals,
  percent,
  project,
  projectName,
  projectShares,
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

type Alerts = { resetsAt: number; sent: string[] }

const samplesKey = (kind: string) => `samples:${kind}`
const bucketKey = (kind: string) => `tokens:${kind}`
const alertsKey = (kind: string) => `alerts:${kind}`
const mixKey = (kind: string) => `mix:${kind}`
const projectsKey = (kind: string) => `projects:${kind}`
const ECONOMY_KEY = 'economy'

const resetOf = (w: SessionRateLimit) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN)

const loadMix = async ($: EngineInterface, w: WindowView): Promise<Mix | undefined> => {
  const held = (await $.store.get(mixKey(w.kind))) as Mix | undefined

  return held && w.resetsAt !== undefined && sameWindow(held.resetsAt, w.resetsAt) ? held : undefined
}

/** Grava uma leitura de cada janela e recalcula tudo, a recomendação inclusive. */
const refresh = async ($: EngineInterface, usage: SessionUsage, record: boolean) => {
  const now = await $.clock.now()
  const windows: WindowView[] = []
  const mixes: Record<string, Mix | undefined> = {}

  for (const raw of usage.rateLimits) {
    const resetsAt = resetOf(raw)
    let log = (await $.store.get(samplesKey(raw.kind))) as SampleLog | undefined
    if (record && !Number.isNaN(resetsAt)) {
      log = addSample(log, resetsAt, { t: now, pct: raw.percentUsed })
      await $.store.set(samplesKey(raw.kind), log)
    }
    const bucket = (await $.store.get(bucketKey(raw.kind))) as TokenBucket | undefined
    const view = project(raw, now, log, bucket)
    windows.push(view)
    mixes[raw.kind] = await loadMix($, view)
    const projects = (await $.store.get(projectsKey(raw.kind))) as ProjectBucket | undefined
    if (projects && view.resetsAt !== undefined && sameWindow(projects.resetsAt, view.resetsAt)) {
      view.projects = projectShares(projects, view.pct)
    }
  }

  const next: Snapshot = {
    updatedAt: now,
    windows,
    costUsd: usage.cost?.usd,
    contextPercent: usage.context.percent,
    advice: advise(windows, mixes, await read($, setup)),
  }
  await update($, snapshot, () => next)
  $.ui.status(statusLine(windows, await read($, session), next.costUsd))
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

const actionsFor = ($: EngineInterface, withDetails: boolean): Actions => ({
  details: withDetails ? () => void $.ui.open({ id: PANE, title: 'Limites' }) : undefined,
  toggleEconomy: () => void read($, economy).then(on => setEconomy($, !on)),
  fillModel: alias => void $.prompt.fill({ text: `/model ${alias}` }),
})

const viewData = async ($: EngineInterface, snap: Snapshot): Promise<ViewData> => ({
  snap,
  totals: await read($, session),
  economy: await read($, economy),
})

export const register: Register = on => {
  /** Subagentes já decididos: true roda em Haiku. Um agente nunca troca no meio. */
  const haikuAgents = new Map<string, boolean>()
  const forks = new Set<string>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
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
      $.ui.status(statusLine(last?.windows ?? [], totals, last?.costUsd))
    }

    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
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
