import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'
import {
  SUMMARY_SYSTEM,
  ago,
  duration,
  formatHandoff,
  headline,
  joinPath,
  parseHandoff,
  relative,
  summaryPrompt,
} from './handoff'
import type { GitInfo } from './handoff'

const PANE = 'fluxo-handoff'
const SUMMARY_MODEL = 'claude-haiku-5-5'

const incoming = atom({ plugin: 'fluxo', key: 'incoming' } as const, null)
const edited = atom({ plugin: 'fluxo', key: 'edited' } as const, [])
const summary = atom({ plugin: 'fluxo', key: 'summary' } as const, null)

/** Onde a sessão está: raiz do projeto, nome dela e desta máquina. */
const where = { root: '', project: '', machine: '', summaryAt: null as number | null, written: 0 }

const run = async ($: EngineInterface, argv: string[], cwd: string) => {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

const gitInfo = async ($: EngineInterface, root: string): Promise<GitInfo> => {
  const branch = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root)
  if (branch === undefined) return null
  const status = (await run($, ['git', 'status', '--porcelain'], root)) ?? ''

  return {
    branch,
    dirty: status ? status.split('\n').length : 0,
    lastCommit: (await run($, ['git', 'log', '-1', '--format=%s'], root)) ?? '',
  }
}

/** Resume a conversa com Haiku; undefined quando não dá. */
const summarize = async ($: EngineInterface, note: string) => {
  const messages = await $.session.messages()
  if (!Array.isArray(messages) || messages.length === 0) return undefined
  const lines: string[] = []
  for (const m of messages.slice(-80)) {
    const tools = m.toolUses.map(t => t.tool).join(', ')
    const text = m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text
    if (text || tools) lines.push(`[${m.role}] ${text}${tools ? ` (ferramentas: ${tools})` : ''}`)
  }
  let transcript = lines.join('\n')
  if (transcript.length > 60_000) transcript = transcript.slice(-60_000)
  const answer = await $.model.complete({
    model: SUMMARY_MODEL,
    system: SUMMARY_SYSTEM,
    prompt: summaryPrompt(transcript, note),
    maxTokens: 1500,
    timeoutMs: 90_000,
  })

  return answer.isAnswered ? answer.text.trim() : undefined
}

/** Grava o handoff na raiz do projeto e devolve o caminho. */
const writeHandoff = async ($: EngineInterface, path: string) => {
  const at = await $.clock.now()
  const text = formatHandoff({
    project: where.project,
    machine: where.machine,
    at,
    summary: await read($, summary),
    summaryAt: where.summaryAt,
    edited: await read($, edited),
    git: await gitInfo($, where.root),
  })
  const file = joinPath(where.root, path)
  await $.fs.write(file, text)
  where.written = (await read($, edited)).length

  return file
}

/** Mostra o handoff de outra máquina, se houver um novo. */
const loadIncoming = async ($: EngineInterface, path: string) => {
  const file = joinPath(where.root, path)
  if (!(await $.fs.exists(file))) return
  const found = parseHandoff(await $.fs.read(file))
  if (!found || found.machine === where.machine) return
  const seen = await $.store.get(`seen:${where.root}`)
  if (seen === found.at) return
  await update($, incoming, () => found)
}

const dismiss = async ($: EngineInterface, handoff: Handoff) => {
  await $.store.set(`seen:${where.root}`, handoff.at)
  await update($, incoming, () => null)
}

export const register: Register = (on, options) => {
  const handoffPath = String(options.handoffPath ?? '.claude/handoff.md')
  const longTurnMs = Number(options.longTurnMinutes ?? 3) * 60_000

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const top = await run($, ['git', 'rev-parse', '--show-toplevel'], started.cwd)
    where.root = top || started.cwd
    where.project = where.root.split(/[\\/]/).filter(Boolean).pop() ?? where.root
    where.machine = ((await run($, ['hostname'], started.cwd)) ?? 'esta máquina').replace(/\.local$/, '')
    await $.command.register({
      name: 'handoff',
      description: 'Resume onde você parou e grava em .claude/handoff.md para continuar em outra máquina',
      argumentHint: '[observação opcional]',
    })
    await loadIncoming($, handoffPath)

    return started
  })

  // Anota os arquivos que a sessão editou.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const path =
      e.tool === 'Edit' || e.tool === 'Write'
        ? e.file_path
        : e.tool === 'NotebookEdit'
          ? e.notebook_path
          : undefined
    if (path && !ran.deny && !ran.isError && where.root) {
      const rel = relative(where.root, path)
      await update($, edited, list => (list.includes(rel) ? list : [...list, rel].slice(-300)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result

    if (options.autoHandoff !== false && where.root) {
      const count = (await read($, edited)).length
      if (count > where.written) await writeHandoff($, handoffPath)
    }

    if (e.durationMs >= longTurnMs && !e.isAborted) {
      $.ui.toast(`✓ Turno terminou em ${duration(e.durationMs)}`, { timeoutMs: 10_000 })
      if (options.sound !== false) void $.audio.play({ asset: 'sounds/done.wav' }).catch(() => undefined)
      if (options.speak === true) void $.audio.speak('Claude terminou').catch(() => undefined)
    }

    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    if (!where.root) return { text: 'Sem pasta de projeto nesta sessão.' }
    const text = await summarize($, e.args.trim())
    if (text) {
      await update($, summary, () => text)
      where.summaryAt = await $.clock.now()
    }
    const file = await writeHandoff($, handoffPath)

    return {
      text:
        `Handoff salvo em ${file}${text ? '' : ' (sem resumo: a conversa não pôde ser resumida)'}.\n` +
        'Leve o arquivo para a outra máquina junto com o projeto (commit e push, ou pasta sincronizada). ' +
        'Lá, a próxima sessão no projeto mostra o handoff acima do prompt.',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Markdown, Text } = $.ui.resolve(e)
    const handoff = await read($, incoming)

    return handoff ? <Markdown text={handoff.text.replace(/<!--[\s\S]*?-->\n?/, '')} /> : <Text dimColor>Nenhum handoff pendente.</Text>
  })

  // Acima do prompt: o handoff que chegou de outra máquina, sobre o que os outros plugins desenham.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const handoff = await read($, incoming)
    if (handoff === null || e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()

    return (
      <Box flexDirection="column">
        <Box flexDirection="column">
          <Text color="suggestion">
            ↪ Handoff de {handoff.machine} ({ago(now - handoff.at)}): {headline(handoff)}
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Button
              key="fluxo-continue"
              label="Continuar daqui"
              variant="primary"
              onPress={() => {
                void $.prompt.fill({
                  text: `Leia ${handoffPath} e continue de onde a outra máquina parou.`,
                })
                void dismiss($, handoff)
              }}
            />
            <Button key="fluxo-view" label="Ver" onPress={() => void $.ui.open({ id: PANE, title: 'Handoff' })} />
            <Button key="fluxo-dismiss" label="Dispensar" plain onPress={() => void dismiss($, handoff)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
