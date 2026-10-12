import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Board, Item, ItemStatus, Roadmap, Summary } from '../types'
import {
  BAND_TITLE_MAX,
  DONE_SHOWN,
  ITEM_LABEL,
  ITEM_MARK,
  PANE_LIMIT,
  PHASE_LABEL,
  applyAdd,
  applyUpdate,
  barSvg,
  cut,
  hash,
  missingText,
  ownerLabel,
  parseRoadmap,
  pendingDeps,
  phaseLabel,
  recentDone,
  reportText,
  staleText,
  startPrompt,
  statusLine,
  summarize,
  textBar,
} from './roadmap'
import type { AddInput, Change, StatusInput, UpdateInput } from './roadmap'

const PANE = 'roadmap'

const board = atom({ plugin: 'roadmap', key: 'board' } as const, null)
const stale = atom({ plugin: 'roadmap', key: 'stale' } as const, null)
const hidden = atom({ plugin: 'roadmap', key: 'hidden' } as const, null)
const notice = atom({ plugin: 'roadmap', key: 'notice' } as const, null)

/** Onde está o roadmap desta sessão. */
const where = { root: '', file: '', rel: '', project: '', hasGit: false, staleAt: 0 }

const isAbsolute = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p)
const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, '')}/${rel.replace(/^[\\/]+/, '')}`
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()

const today = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const COLOR = { done: '#2f9e62', current: '#d97757', todo: '#8a8f98' } as const
const THEME = { done: 'success', current: 'claude', todo: 'subtle' } as const

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

const say = async ($: EngineInterface, text: string) => {
  await update($, notice, () => text)
  $.ui.toast(text, { timeoutMs: 6000 })
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
      await say($, `${by}: ${result.message}`)

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
type Bar = (pct: number, tone: keyof typeof COLOR, key: string) => RenderElement
type Acts = { start: (item: Item) => () => void; view: () => void; hide: () => void; reload: () => void; create: () => void }
type View = { b: Board; r: Roadmap; s: Summary; warning?: string }

/** A faixa: uma linha com a fase, o %, a próxima (com o título cortado) e o que você pode fazer agora. */
const Band = (ui: BasicUi, v: View, bar: Bar | undefined, act: Acts) => {
  const { Box, Text, Button } = ui
  const { r, s } = v
  const first = s.next[0]
  const cur = s.current
  const who = first ? ownerLabel(first, r) : undefined
  const isAllDone = r.items.length > 0 && r.items.every(i => i.status === 'done')

  return (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
      {bar && cur ? bar(cur.pct, 'current', 'roadmap-bar') : undefined}
      <Text>
        <Text bold color="claude">
          Roadmap
        </Text>
        {cur ? (
          <Text>
            {' · '}
            <Text bold>{phaseLabel(cur.phase)}</Text> · {cur.pct}%
          </Text>
        ) : (
          <Text dimColor> · sem fases</Text>
        )}
        {first ? (
          <Text>
            {' · '}
            <Text bold>Próxima:</Text> {cut(first.title, BAND_TITLE_MAX)}
            {who ? <Text dimColor> ({who})</Text> : ''}
          </Text>
        ) : (
          <Text dimColor> · {isAllDone ? 'tudo feito' : 'nada livre agora'}</Text>
        )}
        {s.mineNow.length > 0 ? <Text dimColor> · {s.mineNow.length} com você agora</Text> : ''}
      </Text>
      {v.warning ? <Text color="warning">{v.warning}</Text> : undefined}
      {first ? <Button key="roadmap-go" label="Fazer a próxima" plain onPress={act.start(first)} /> : undefined}
      <Button key="roadmap-view" label="Ver roadmap" plain onPress={act.view} />
      <Button key="roadmap-hide" label="Ocultar" plain onPress={act.hide} />
    </Box>
  )
}

const ErrorBand = (ui: BasicUi, b: Board, act: Acts) => {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
      <Text>
        <Text bold color="claude">
          Roadmap
        </Text>
        <Text color="error"> · roadmap com erro: {b.error}</Text>
      </Text>
      <Button key="roadmap-view" label="Ver roadmap" plain onPress={act.view} />
      <Button key="roadmap-hide" label="Ocultar" plain onPress={act.hide} />
    </Box>
  )
}

/** O painel /roadmap: fases, próximas, com você, esperando e a fase atual por estado. */
const Pane = (ui: BasicUi, v: View, bar: Bar, act: Acts, last: string | null) => {
  const { Box, Text, Button } = ui
  const { b, r, s } = v
  const labelWidth = Math.min(36, Math.max(...s.phases.map(p => phaseLabel(p.phase).length + 2), 10))
  const itemLine = (i: Item, extra?: string) => {
    const who = ownerLabel(i, r)
    const deps = pendingDeps(i, r)
    const details = [
      who,
      i.phase !== s.current?.phase.id && `Fase ${i.phase}`,
      i.gate && 'gate',
      extra,
      i.status === 'blocked' && i.waitingOn && `espera: ${i.waitingOn}`,
      deps.length > 0 && `depende de: ${deps.map(d => d.title).join(', ')}`,
    ].filter(Boolean)

    return (
      <Text>
        {ITEM_MARK[i.status]} {i.title}
        {details.length > 0 ? <Text dimColor> · {details.join(' · ')}</Text> : ''}
      </Text>
    )
  }
  const more = (key: string, n: number, indent = 0) =>
    n > 0 ? (
      <Box key={key} paddingLeft={indent}>
        <Text dimColor>… e mais {n}</Text>
      </Box>
    ) : undefined
  /** Uma lista com título, cortada em PANE_LIMIT, e uma linha de contagem das outras fases. */
  const section = (key: string, title: string, list: Item[], render: (i: Item) => RenderElement, elsewhere?: string) =>
    list.length === 0 && !elsewhere ? undefined : (
      <Box key={key} flexDirection="column" marginTop={1}>
        {list.length > 0 ? (
          <Text bold>
            {title} ({list.length})
          </Text>
        ) : undefined}
        {list.slice(0, PANE_LIMIT).map(render)}
        {more(`${key}-more`, list.length - PANE_LIMIT)}
        {elsewhere ? <Text dimColor>{elsewhere}</Text> : undefined}
      </Box>
    )
  const byStatus = (status: ItemStatus) => r.items.filter(i => i.phase === s.current?.phase.id && i.status === status)
  const doneTotal = s.doneElsewhere.reduce((sum, d) => sum + d.count, 0)
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const doneHere = byStatus('done')

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={2} flexWrap="wrap" justifyContent="space-between">
        <Text>
          <Text bold>{r.project ?? b.project}</Text>
          {r.goal ? <Text dimColor> · {r.goal}</Text> : ''}
        </Text>
        <Button key="roadmap-reload" label="↻" plain onPress={act.reload} />
      </Box>
      <Text dimColor>
        {r.updated ? `atualizado em ${r.updated} · ` : ''}
        {b.rel}
      </Text>
      {v.warning ? <Text color="warning">⚠ {v.warning}</Text> : undefined}

      <Box key="phases" flexDirection="column" marginTop={1}>
        <Text bold>Fases</Text>
        {s.phases.length === 0 ? <Text dimColor>Nenhuma fase.</Text> : undefined}
        {s.phases.map(p => {
          const tone = p.isCurrent ? 'current' : p.phase.status === 'done' ? 'done' : 'todo'
          const mark = p.isCurrent ? '▶' : p.phase.status === 'done' ? '✓' : '○'
          const gate = p.phase.gate ? `gate: ${p.phase.gate}${p.phase.gateStatus ? ` (${p.phase.gateStatus})` : ''}` : undefined

          return (
            <Box key={`phase-${p.phase.id}`} flexDirection="row" columnGap={1} flexWrap="wrap" alignItems="center">
              <Box minWidth={labelWidth}>
                <Text bold={p.isCurrent} color={p.isCurrent ? 'claude' : undefined}>
                  {mark} {phaseLabel(p.phase)}
                </Text>
              </Box>
              {bar(p.pct, tone, `bar-${p.phase.id}`)}
              <Text bold={p.isCurrent}>
                {p.pct}% <Text dimColor>· {p.total > 0 ? `${p.done}/${p.total} · ` : ''}{PHASE_LABEL[p.phase.status]}</Text>
              </Text>
              {gate ? <Text dimColor>· {gate}</Text> : undefined}
            </Box>
          )
        })}
      </Box>

      {s.next.length > 0 ? (
        <Box key="next" flexDirection="column" marginTop={1}>
          <Text bold>Próximas</Text>
          {s.next.map(i => (
            <Box key={`next-${i.id}`} flexDirection="row" columnGap={1} flexWrap="wrap">
              {itemLine(i)}
              <Button key={`ask-${i.id}`} label="Pedir ao Claude" plain onPress={act.start(i)} />
            </Box>
          ))}
        </Box>
      ) : (
        <Box key="next" marginTop={1}>
          <Text dimColor>Nenhuma tarefa livre agora.</Text>
        </Box>
      )}
      {section('mine-now', 'Com você agora', s.mineNow, i => (
        <Box key={`mine-${i.id}`}>{itemLine(i, i.status !== 'todo' ? ITEM_LABEL[i.status] : undefined)}</Box>
      ))}
      {section(
        'mine-later',
        'Com você depois',
        s.mineLater,
        i => <Box key={`later-${i.id}`}>{itemLine(i, i.status !== 'todo' ? ITEM_LABEL[i.status] : undefined)}</Box>,
        s.mineElsewhere > 0 ? `${plural(s.mineElsewhere, 'item', 'itens')} com você em outras fases` : undefined,
      )}
      {section(
        'waiting',
        'Esperando',
        s.waiting,
        i => <Box key={`wait-${i.id}`}>{itemLine(i)}</Box>,
        s.waitingElsewhere > 0 ? `${plural(s.waitingElsewhere, 'bloqueado', 'bloqueados')} em outras fases` : undefined,
      )}

      {s.current ? (
        <Box key="current" flexDirection="column" marginTop={1}>
          <Text bold color="claude">
            {phaseLabel(s.current.phase)}
            {s.current.phase.goal ? <Text dimColor> · {s.current.phase.goal}</Text> : ''}
          </Text>
          {(['doing', 'todo', 'blocked'] as const).map(status => {
            const list = byStatus(status)
            if (list.length === 0) return undefined

            return (
              <Box key={`cur-${status}`} flexDirection="column">
                <Text dimColor>
                  {ITEM_LABEL[status]} ({list.length})
                </Text>
                {list.slice(0, PANE_LIMIT).map(i => (
                  <Box key={`cur-${i.id}`} paddingLeft={2}>
                    {itemLine(i)}
                  </Box>
                ))}
                {more(`cur-${status}-more`, list.length - PANE_LIMIT, 2)}
              </Box>
            )
          })}
          {doneHere.length > 0 ? (
            <Box key="cur-done" flexDirection="column">
              <Text dimColor>
                {doneHere.length > DONE_SHOWN ? `feitos (${doneHere.length}), os últimos ${DONE_SHOWN}` : `feitos (${doneHere.length})`}
              </Text>
              {recentDone(r, s.current.phase.id, DONE_SHOWN).map(i => (
                <Box key={`cur-${i.id}`} paddingLeft={2}>
                  {itemLine(i, [i.doneAt, i.evidence && cut(i.evidence, 80)].filter(Boolean).join(' · ') || undefined)}
                </Box>
              ))}
            </Box>
          ) : undefined}
        </Box>
      ) : undefined}

      {doneTotal > 0 ? (
        <Box key="done-elsewhere" marginTop={1}>
          <Text dimColor>
            Feitos em outras fases: {doneTotal} ({s.doneElsewhere.map(d => `Fase ${d.phase.id}: ${d.count}`).join(' · ')})
          </Text>
        </Box>
      ) : undefined}

      {s.decisions.length > 0 || s.decisionsElsewhere > 0 ? (
        <Box key="decisions" flexDirection="column" marginTop={1}>
          {s.decisions.length > 0 ? <Text bold>Decisões em aberto ({s.decisions.length})</Text> : undefined}
          {s.decisions.slice(0, PANE_LIMIT).map((d, n) => (
            <Text key={`dec-${n}`}>
              • {d.title}
              {d.phase || d.ref ? <Text dimColor> · {[d.phase && `Fase ${d.phase}`, d.ref].filter(Boolean).join(' · ')}</Text> : ''}
            </Text>
          ))}
          {more('dec-more', s.decisions.length - PANE_LIMIT)}
          {s.decisionsElsewhere > 0 ? (
            <Text dimColor>{plural(s.decisionsElsewhere, 'decisão em aberto', 'decisões em aberto')} de outras fases</Text>
          ) : undefined}
        </Box>
      ) : undefined}

      {last ? (
        <Box key="notice" marginTop={1}>
          <Text dimColor>{last}</Text>
        </Box>
      ) : undefined}
    </Box>
  )
}

/** O painel quando não há roadmap, ou quando o arquivo tem erro. */
const EmptyPane = (ui: BasicUi, b: Board | null, act: Acts) => {
  const { Box, Text, Button } = ui
  const rel = b?.rel ?? where.rel

  if (b?.exists) {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2} justifyContent="space-between">
          <Text bold>{b.project}</Text>
          <Button key="roadmap-reload" label="↻" plain onPress={act.reload} />
        </Box>
        <Text color="error">O roadmap tem erro: {b.error}</Text>
        <Text dimColor>Corrija {rel}; o mod relê o arquivo sozinho.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>Não há roadmap em {rel}.</Text>
      <Text dimColor>É um JSON com as fases e os itens do projeto (o formato está no README do mod).</Text>
      <Box marginTop={1}>
        <Button key="roadmap-create" label="Pedir ao Claude para criar" onPress={act.create} />
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
  'Monte as fases e os itens a partir do que já existe no projeto (README, docs, tarefas) e me mostre antes de gravar.'

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
  const warning = staleText(await read($, stale), staleAfter)

  return { b, r: b.roadmap, s: summarize(b.roadmap), warning }
}

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
      await $.command.register({ name: 'roadmap', description: 'Mostra o roadmap do projeto: fases, próximas tarefas e o que está com você' })
    } catch {
      // Outro plugin já tem esse comando: a faixa e as ferramentas continuam.
    }
    await $.tool.register({
      name: 'roadmap_status',
      description:
        'Mostra o roadmap do projeto: a fase atual e o %, as 5 próximas tarefas (com os ids), o que está com o usuário ' +
        'e o que está esperando na fase atual (as outras fases só como contagem), e se o roadmap está desatualizado. ' +
        'Para achar o id de um item, passe query com palavras do título (até 10 itens, com id, estado, dono, fase e ' +
        'notas); phase lista uma fase inteira; all: true mostra tudo sem cortes. Sem roadmap no projeto, diz onde ' +
        'criar e mostra o formato, com cada campo.',
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
          'waitingOn) ou para reabrir (todo). "done" sem doneAt usa a data de hoje. Com o id de uma fase, muda o estado ' +
          'da fase (done, doing ou todo) e "evidence" vira o resultado do gate. Use esta ferramenta em vez de editar o JSON à mão.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id do item (ou da fase)' },
            status: { type: 'string', enum: ['done', 'doing', 'todo', 'blocked'] },
            evidence: { type: 'string', description: 'O que prova que está feito: commit, arquivo, teste, print' },
            doneAt: { type: 'string', description: 'Data AAAA-MM-DD; sem ela, "done" usa a de hoje' },
            note: { type: 'string', description: 'Observação que entra nas notas do item' },
            waitingOn: { type: 'string', description: 'Com "blocked": o que o item espera' },
          },
          required: ['id', 'status'],
        },
      })
      await $.tool.register({
        name: 'roadmap_add',
        description:
          'Cria um item no roadmap, numa fase que já existe; o id sai do título. Use quando surgir trabalho novo que faz ' +
          'parte do plano (não para o que vai fazer agora mesmo). "after" põe o item logo depois de outro, no arquivo e ' +
          'no caminho; sem ele, o item vai para o fim da fase.',
        inputSchema: {
          type: 'object',
          properties: {
            phase: { type: 'string', description: 'Id da fase' },
            title: { type: 'string', description: 'Curto e acionável' },
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
    if (v === null || !('s' in v)) return { text: v?.exists ? `O roadmap (${v.rel}) tem erro: ${v.error}` : `Não há roadmap em ${where.rel}.` }
    const first = v.s.next[0]

    return {
      text: [
        `Roadmap: ${v.s.current ? `${phaseLabel(v.s.current.phase)} · ${v.s.current.pct}%` : 'sem fases'}`,
        first ? `próxima: ${first.title} (${first.id})` : 'nada livre agora',
        v.warning,
      ]
        .filter(Boolean)
        .join(' · '),
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await view($, staleAfter)
    const last = await read($, notice)
    const b = v !== null && 's' in v ? v.b : v
    const act = acts($, b, claudeCanEdit)
    if (e.surface === 'terminal') {
      const ui = $.ui.resolve(e)
      const bar: Bar = (pct, tone, key) => (
        <ui.Text key={key} color={THEME[tone]}>
          {textBar(pct, 12)}
        </ui.Text>
      )
      return v !== null && 's' in v ? Pane(ui, v, bar, act, last) : EmptyPane(ui, b, act)
    }
    const ui = $.ui.resolve(e)
    const width = Math.max(60, Math.min(160, e.props.bodyColumns * 2))
    const bar: Bar = (pct, tone, key) => (
      <ui.Svg key={key} source={barSvg(pct, width, COLOR[tone])} alt={`${pct}% feito`} width={width} height={8} />
    )

    return v !== null && 's' in v ? Pane(ui, v, bar, act, last) : EmptyPane(ui, b, act)
  })

  // Acima do prompt: a fase, o % e a próxima, empilhado com o que outros plugins desenham.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!showBand || e.props.hasSurvey) return below
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return below
    const v = await view($, staleAfter)
    if (v === null || (!('s' in v) && !v.exists)) return below
    const b = 's' in v ? v.b : v
    if ((await read($, hidden)) === b.sig) return below
    const act = acts($, b, claudeCanEdit)
    if (e.surface === 'terminal') {
      const ui = $.ui.resolve(e)

      return (
        <ui.Box flexDirection="column">
          {'s' in v ? Band(ui, v, undefined, act) : ErrorBand(ui, b, act)}
          {below}
        </ui.Box>
      )
    }
    const ui = $.ui.resolve(e)
    const bar: Bar = (pct, tone, key) => (
      <ui.Svg key={key} source={barSvg(pct, 72, COLOR[tone])} alt={`${pct}% da fase feito`} width={72} height={8} />
    )

    return (
      <ui.Box flexDirection="column">
        {'s' in v ? Band(ui, v, bar, act) : ErrorBand(ui, b, act)}
        {below}
      </ui.Box>
    )
  })
}
