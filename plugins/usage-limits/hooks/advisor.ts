import type { Advice, Mix, Scenario, ScenarioId, Setup, Tokens, WindowView } from '../types'
import { HAIKU, SONNET, costOf, family, modelKey, modelLabel } from './pricing'
import { HOUR, hours, percent } from './projection'

export const emptyMix = (resetsAt: number): Mix => ({ resetsAt, main: {}, sub: {} })

/** Junta os tokens de uma resposta ao modelo e ao papel que a fizeram. */
export const addToMix = (mix: Mix, role: 'main' | 'sub', model: string, t: Tokens): Mix => {
  const key = modelKey(model)
  const held = mix[role][key] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  return {
    ...mix,
    [role]: {
      ...mix[role],
      [key]: {
        input: held.input + t.input,
        output: held.output + t.output,
        cacheRead: held.cacheRead + t.cacheRead,
        cacheWrite: held.cacheWrite + t.cacheWrite,
      },
    },
  }
}

const costAt = (byModel: Record<string, Tokens>, as?: string) =>
  Object.entries(byModel).reduce((sum, [key, t]) => sum + costOf(t, as ?? key), 0)

const windowName = (kind: string) =>
  kind === 'five_hour' ? 'de 5h' : kind.startsWith('seven_day') ? 'semanal' : kind

/** Do menos ao mais disruptivo para a qualidade do trabalho. */
const ORDER: ScenarioId[] = ['sub-haiku', 'all-sonnet', 'main-sonnet-sub-haiku', 'all-haiku']

/** Abaixo disso o limite chega ao reset com folga. */
const COMFORT = 85

/**
 * Recomenda a troca de modelo menos disruptiva que faz o limite mais apertado
 * durar até o reset, estimando o gasto de cada cenário pelo preço de API.
 */
export const advise = (
  windows: WindowView[],
  mixes: Record<string, Mix | undefined>,
  setup: Setup,
  recent?: Mix,
): Advice | undefined => {
  const open = windows.filter(
    w => w.ratePerHour !== undefined && w.msToReset !== undefined && w.verdict !== 'exhausted',
  )
  const binding = open.reduce<WindowView | undefined>(
    (worst, w) => (worst === undefined || (w.pctAtReset ?? 0) > (worst.pctAtReset ?? 0) ? w : worst),
    undefined,
  )
  if (binding === undefined) return undefined

  const mainKey = setup.mainModel ? modelKey(setup.mainModel) : undefined
  const mainName = mainKey ? modelLabel(mainKey) : 'o modelo atual'
  const name = windowName(binding.kind)
  // O gasto das últimas horas mostra o que você está usando agora; a janela toda só na falta dele.
  const mix = recent ?? mixes[binding.kind]
  const mainCost = mix ? costAt(mix.main) : 0
  const subCost = mix ? costAt(mix.sub) : 0
  const total = mainCost + subCost
  const subModels = mix ? Object.keys(mix.sub).filter(k => costOf(mix.sub[k]!, k) > 0) : []
  const advice: Advice = {
    windowKind: binding.kind,
    windowLabel: binding.label,
    mainModel: mainKey,
    mainEffort: setup.mainEffort,
    subShare: total > 0 ? subCost / total : 0,
    subModels,
    scenarios: [],
    isFine: binding.verdict === 'ok',
    mixBasis: recent ? 'recent' : 'window',
    headline: '',
  }
  if (setup.mainEffort === 'xhigh' || setup.mainEffort === 'max') {
    advice.tip = `Baixar o effort de ${setup.mainEffort} para high (/effort high) também reduz o gasto do fio principal.`
  }

  if (total > 0 && mix) {
    const costs: Record<ScenarioId, number> = {
      'sub-haiku': mainCost + costAt(mix.sub, HAIKU),
      'all-sonnet': costAt(mix.main, SONNET) + costAt(mix.sub, SONNET),
      'main-sonnet-sub-haiku': costAt(mix.main, SONNET) + costAt(mix.sub, HAIKU),
      'all-haiku': costAt(mix.main, HAIKU) + costAt(mix.sub, HAIKU),
    }
    const labels: Record<ScenarioId, string> = {
      'sub-haiku': `${mainName} orquestra, Haiku executa`,
      'all-sonnet': 'Sonnet 5.5 em tudo',
      'main-sonnet-sub-haiku': 'Sonnet orquestra, Haiku executa',
      'all-haiku': 'Haiku 5.5 em tudo',
    }
    const rate = binding.ratePerHour ?? 0
    for (const id of ORDER) {
      const factor = costs[id] / total
      const seen = advice.scenarios.some(s => Math.abs(s.factor - factor) < 0.02)
      if (factor > 0.97 || seen) continue
      const scenarioRate = rate * factor
      const pctAtReset = binding.pct + scenarioRate * (binding.hoursAhead ?? (binding.msToReset ?? 0) / HOUR)
      advice.scenarios.push({
        id,
        label: labels[id],
        factor,
        hoursLeft: scenarioRate > 0 ? (100 - binding.pct) / scenarioRate : undefined,
        pctAtReset,
        lasts: pctAtReset < 100,
      })
    }
  }

  const unit = binding.rateSource === 'work' ? ' de uso' : ''

  if (advice.isFine) {
    advice.headline =
      `✓ Mantendo o uso atual, seu plano dura até o reset ` +
      `(~${percent(binding.pctAtReset ?? binding.pct)} do limite ${name} no fim).`

    return advice
  }

  const pick =
    advice.scenarios.find(s => s.pctAtReset < COMFORT) ?? advice.scenarios.find(s => s.lasts)
  const current =
    `Você está usando ${mainName}` +
    (setup.mainEffort ? ` (effort ${setup.mainEffort})` : '') +
    (advice.subShare >= 0.1
      ? ` e ${percent(advice.subShare * 100)} do gasto vem de subagentes em ${subModels.map(modelLabel).join(', ')}`
      : '')

  if (pick === undefined) {
    const best = advice.scenarios.reduce<Scenario | undefined>(
      (low, s) => (low === undefined || s.factor < low.factor ? s : low),
      undefined,
    )
    advice.headline =
      best === undefined
        ? `⚠ No ritmo atual o limite ${name} acaba antes do reset. Use ${mainName} só para orquestrar e ` +
          'deixe a execução para subagentes em Haiku.'
        : `⚠ ${current}. Nem com ${best.label} o limite ${name} chega ao reset; ` +
          `assim ele dura ~${hours(best.hoursLeft ?? 0)}${unit} em vez de ~${hours(binding.hoursLeft ?? 0)}${unit}.`

    return advice
  }

  advice.pick = pick.id
  const action: Record<ScenarioId, string> = {
    'sub-haiku': `use ${mainName} para orquestrar e Haiku para executar`,
    'all-sonnet': 'troque para Sonnet 5.5 (/model sonnet)',
    'main-sonnet-sub-haiku': 'use Sonnet 5.5 para orquestrar (/model sonnet) e Haiku para executar',
    'all-haiku': 'use Haiku 5.5 em tudo (/model haiku)',
  }
  advice.headline =
    `💡 ${current}. Para não ficar sem uso, ${action[pick.id]}: ` +
    `o limite ${name} passa a durar ~${hours(pick.hoursLeft ?? 0)}${unit} e seu plano dura até o reset ` +
    `(~${percent(pick.pctAtReset)} no fim).`

  return advice
}

/** Se um cenário põe os subagentes em Haiku (o que o modo economia faz). */
export const usesSubHaiku = (id: ScenarioId | undefined) =>
  id === 'sub-haiku' || id === 'main-sonnet-sub-haiku' || id === 'all-haiku'

/** Se um cenário pede outro modelo no fio principal. */
export const changesMain = (id: ScenarioId | undefined, mainModel?: string) =>
  (id === 'all-sonnet' || id === 'main-sonnet-sub-haiku') && family(mainModel ?? '') !== 'sonnet'
