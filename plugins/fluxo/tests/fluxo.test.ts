import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { formatHandoff, headline, openTasks, parseHandoff, relative } from '../hooks/handoff'

const NOW = Date.parse('2026-10-08T12:00:00Z')

test('handoff: escreve e lê de volta', () => {
  const text = formatHandoff({
    project: 'my-game',
    machine: 'MacBook',
    at: NOW,
    summary: '## Onde parei\nPortando a esquiva para o FishNet.\n\n## Próximos passos\n- testar PlayMode',
    summaryAt: NOW,
    edited: ['client/MyGame/Assets/Scripts/Core/Dodge.cs'],
    git: null,
  })
  const h = parseHandoff(text)
  expect(h?.machine).toBe('MacBook')
  expect(h?.at).toBe(NOW)
  expect(h && headline(h)).toBe('Portando a esquiva para o FishNet.')
  expect(text).toContain('- client/MyGame/Assets/Scripts/Core/Dodge.cs')
  expect(text).toContain('Pasta sem git')
  expect(parseHandoff('# só um markdown')).toBeUndefined()
})

test('caminho relativo à raiz, no Mac e no Windows', () => {
  expect(relative('/home/dev/my-game', '/home/dev/my-game/client/x.cs')).toBe('client/x.cs')
  expect(relative('C:\\dev\\Jogo', 'c:\\dev\\Jogo\\Assets\\a.cs')).toBe('Assets/a.cs')
  expect(relative('/a', '/b/c.cs')).toBe('/b/c.cs')
})

type Files = Record<string, string>

/** Disco, git e hostname de mentira por baixo do plugin. */
const machine = (
  on: On,
  files: Files,
  host: string,
  toasts: string[] = [],
  commands: { refuse?: string[]; registered?: string[] } = {},
) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    const stdout = argv === 'hostname' ? `${host}.local\n` : ''
    const exitCode = argv.startsWith('git') ? 128 : 0

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'missing' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    if (commands.refuse?.includes(e.name)) throw new Error(`"/${e.name}" refused: it is another plugin's command`)
    commands.registered?.push(e.name)
    return { value: { command: e.name } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('audio.play', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
}

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

test('mostra o handoff que veio de outra máquina e esconde ao dispensar', async ($, on) => {
  const files: Files = {
    '/proj/.claude/handoff.md': formatHandoff({
      project: 'proj',
      machine: 'PC-Windows',
      at: NOW - 3 * 3_600_000,
      summary: '## Onde parei\nAjustando a câmera.',
      summaryAt: NOW - 3 * 3_600_000,
      edited: [],
      git: null,
    }),
  }
  machine(on, files, 'MacBook')
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'fluxo', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ text: /Handoff de PC-Windows \(há 3h\): Ajustando a câmera\./ })).toBeDefined()
  await ui.press({ key: 'fluxo-dismiss' })
  expect(await ui.find({ text: /Handoff de/ })).toBeUndefined()
})

test('não mostra o handoff escrito por esta mesma máquina', async ($, on) => {
  const files: Files = {
    '/proj/.claude/handoff.md': formatHandoff({
      project: 'proj', machine: 'MacBook', at: NOW, summary: null, summaryAt: null, edited: [], git: null,
    }),
  }
  machine(on, files, 'MacBook')
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'fluxo', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ text: /Handoff de/ })).toBeUndefined()
})

test('com o handoff automático ligado, edição grava o handoff; turno longo avisa', { options: { autoHandoff: true } }, async ($, on) => {
  const files: Files = {}
  const toasts: string[] = []
  machine(on, files, 'MacBook', toasts)
  on('tool.call', () => ({ result: { type: 'update' } }) as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.cs', content: 'x' })
  await $.turn.complete({
    answer: 'ok', durationMs: 5 * 60_000, isAborted: false, turnId: 't', reason: 'answer',
  })

  const written = files['/proj/.claude/handoff.md']
  expect(written).toContain('- src/a.cs')
  expect(parseHandoff(written ?? '')?.machine).toBe('MacBook')
  expect(toasts).toEqual(['✓ Turno terminou em 5min'])
})

test('handoff automático vem desligado: editar não cria arquivo no projeto', async ($, on) => {
  const files: Files = {}
  machine(on, files, 'MacBook')
  on('tool.call', () => ({ result: { type: 'update' } }) as never)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/proj/src/a.cs', content: 'x' })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't', reason: 'answer' })
  expect(files['/proj/.claude/handoff.md']).toBeUndefined()
})

test('o handoff leva as tarefas abertas do TASKS.md', () => {
  const tasks = openTasks('# Tasks\n\n## Active\n- [ ] **Portar a esquiva** - FishNet\n- [x] ~~Feita~~\n\n## Someday\n- [ ] Ideia solta\n\n## Waiting On\n- [ ] Folhas do artista\n')
  expect(tasks).toEqual(['Portar a esquiva - FishNet', 'Folhas do artista'])
  const text = formatHandoff({ project: 'p', machine: 'm', at: NOW, summary: null, summaryAt: null, edited: [], git: null, tasks })
  expect(text).toContain('## Tarefas abertas (TASKS.md)\n- [ ] Portar a esquiva - FishNet\n- [ ] Folhas do artista')
})

test('se outro plugin já tem /handoff, usa /passagem e o resto do mod segue funcionando', async ($, on) => {
  const files: Files = {}
  const toasts: string[] = []
  const registered: string[] = []
  machine(on, files, 'MacBook', toasts, { refuse: ['handoff'], registered })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['passagem'])
  // O aviso de turno longo continua de pé.
  await $.turn.complete({ answer: 'ok', durationMs: 4 * 60_000, isAborted: false, turnId: 't', reason: 'answer' })
  expect(toasts).toEqual(['✓ Turno terminou em 4min'])
})
