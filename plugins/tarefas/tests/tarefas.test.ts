import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { TEMPLATE, addTask, completeTask, extractPending, findTask, moveTask, parseTasks, splitTitle } from '../hooks/tasks'

// Um TASKS.md editado à mão, no formato da skill de tarefas, com sub-itens e texto livre.
const HAND = `# Tasks

Notas soltas que o mod não pode estragar.

## Active
- [ ] **Portar a esquiva para o FishNet** - PlayerSimulation, 10 ticks
  - i-frames 1 a 8
- [ ] Configurar licença do Unity no Docker

## Waiting On
- [ ] **Folhas de personagem** - do artista, since 2026-10-01

## Someday

## Done
- [x] ~~Criar projeto Unity 6~~ (2026-10-07)
`

test('lê o TASKS.md da skill, com e sem negrito', () => {
  const tasks = parseTasks(HAND)
  expect(tasks.map(t => [t.section, t.title, t.done])).toEqual([
    ['Active', 'Portar a esquiva para o FishNet', false],
    ['Active', 'Configurar licença do Unity no Docker', false],
    ['Waiting On', 'Folhas de personagem', false],
    ['Done', 'Criar projeto Unity 6', true],
  ])
  expect(tasks[0]?.context).toBe('PlayerSimulation, 10 ticks')
  expect(tasks[3]?.doneAt).toBe('2026-10-07')
  expect(splitTitle('Corrigir câmera - orbita com botão direito')).toEqual({ title: 'Corrigir câmera', context: 'orbita com botão direito' })
})

test('criar tarefa: entra no fim da seção, sem duplicar e sem mexer no resto', () => {
  const r = addTask(HAND, { title: 'Testar PlayMode da esquiva', context: 'depois do FishNet' })
  expect(r.added).toBe(true)
  expect(r.text).toContain(
    '- [ ] Configurar licença do Unity no Docker\n- [ ] **Testar PlayMode da esquiva** - depois do FishNet\n\n## Waiting On',
  )
  expect(r.text).toContain('Notas soltas que o mod não pode estragar.')
  expect(r.text).toContain('  - i-frames 1 a 8')
  // Mesmo título com outra grafia: não duplica.
  expect(addTask(r.text, { title: 'testar playmode da ESQUIVA!' }).added).toBe(false)
  // Sem arquivo: nasce do modelo da skill.
  const fresh = addTask(undefined, { title: 'Primeira' })
  expect(fresh.text.startsWith(TEMPLATE.split('## Waiting On')[0]!.trimEnd())).toBe(true)
  expect(parseTasks(fresh.text).map(t => t.title)).toEqual(['Primeira'])
})

test('concluir: risca, data e vai para Done levando os sub-itens', () => {
  const r = completeTask(HAND, 'esquiva', '2026-10-09')
  expect(r.task?.title).toBe('Portar a esquiva para o FishNet')
  expect(r.text).toContain(
    '## Done\n- [x] ~~Portar a esquiva para o FishNet~~ - PlayerSimulation, 10 ticks (2026-10-09)\n  - i-frames 1 a 8\n- [x] ~~Criar projeto Unity 6~~',
  )
  expect(r.text).not.toContain('## Active\n- [ ] **Portar')
  const again = parseTasks(r.text)
  expect(again.filter(t => !t.done).map(t => t.title)).toEqual(['Configurar licença do Unity no Docker', 'Folhas de personagem'])
})

test('ativar: move de Someday para Active', () => {
  const withSomeday = addTask(HAND, { title: 'Som do golpe do monstro', section: 'Someday' }).text
  const r = moveTask(withSomeday, 'som do golpe', 'Active')
  expect(parseTasks(r.text).find(t => t.title === 'Som do golpe do monstro')?.section).toBe('Active')
  // Palavras em qualquer ordem, como o Claude costuma citar uma tarefa.
  expect(findTask(parseTasks(r.text), 'docker licença')?.title).toBe('Configurar licença do Unity no Docker')
  expect(findTask(parseTasks(r.text), 'tela de login')).toBeUndefined()
  expect(findTask(parseTasks(r.text), 'licença do unity')?.title).toBe('Configurar licença do Unity no Docker')
})

test('importar: seção "Pendente" de notas e caixas abertas de backlog', () => {
  const notas = `# Estado

## Feito
- **Transporte** (UDP): pronto.

## Pendente
- **Conteúdo de missões é provisório.** Só existem as missões 1–5.
- **Som de ataque do monstro** não existe.
  - detalhe que não vira tarefa
- **Pipeline de arte (Rota B)**: não iniciado.

## Decisões tomadas
- Dano = max(1, ataque − defesa).
`
  expect(extractPending(notas, 'NOTAS.md')).toEqual([
    { title: 'Conteúdo de missões é provisório', context: 'Só existem as missões 1–5.', source: 'NOTAS.md' },
    { title: 'Som de ataque do monstro', context: 'não existe.', source: 'NOTAS.md' },
    { title: 'Pipeline de arte (Rota B)', context: 'não iniciado.', source: 'NOTAS.md' },
  ])
  const backlog = `# Backlog\n- [ ] Tela de login\n- [x] Já feito\n\n## Next\n- Ranking semanal - por região\n`
  expect(extractPending(backlog, 'BACKLOG.md').map(p => p.title)).toEqual(['Tela de login', 'Ranking semanal'])
})

/** Um projeto de mentira por baixo do plugin. */
const project = (on: On, files: Record<string, string>) => {
  mock.clock(on, { now: Date.parse('2026-10-09T12:00:00Z') })
  mock.store(on)
  const toasts: string[] = []
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/proj\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'missing' }))
  on('fs.write', ($, e) => ((files[e.path] = e.text), { value: undefined }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: (files[e.path] ?? '').length, mtimeMs: (files[e.path] ?? '').length, isLink: false } }))
  on('fs.list', ($, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: files[f]!.length, mtimeMs: 0, isLink: false })),
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__tarefas__${e.name}` } }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('prompt.fill', () => ({ value: { text: '' } }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)

  return { toasts }
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }

test('o Claude cria e conclui tarefas, com aviso na tela', async ($, on) => {
  const files: Record<string, string> = { '/proj/TASKS.md': HAND }
  const { toasts } = project(on, files)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const added = await $.tool.call({ tool: 'mcp__tarefas__task_add', title: 'Licença .ulf no container', context: 'build Linux' } as never)
  expect(added.result).toBe('Tarefa criada: Licença .ulf no container')
  expect(parseTasks(files['/proj/TASKS.md']!).some(t => t.title === 'Licença .ulf no container' && t.section === 'Active')).toBe(true)
  expect(toasts.at(-1)).toBe('Claude criou a tarefa: Licença .ulf no container')

  const done = await $.tool.call({ tool: 'mcp__tarefas__task_done', title: 'esquiva fishnet' } as never)
  expect(done.result).toBe('Tarefa concluída: Portar a esquiva para o FishNet')
  expect(toasts.at(-1)).toBe('Claude concluiu: Portar a esquiva para o FishNet')
})

test('faixa com a próxima tarefa e painel com campo para criar, nas duas superfícies', async ($, on) => {
  const files: Record<string, string> = { '/proj/TASKS.md': HAND }
  project(on, files)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount({ plugin: 'tarefas', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /Portar a esquiva para o FishNet/ })).toBeDefined()
    expect(await band.find({ text: /3 abertas/ })).toBeDefined()
    expect(await band.find({ type: 'Button', key: 'tarefa-go' })).toBeDefined()
  }

  const pane = await $.ui.mount({
    plugin: 'tarefas',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'tarefas',
    props: { title: 'Tarefas', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  await pane.input({ key: 'new', text: 'Ranking semanal - por região' })
  expect(parseTasks(files['/proj/TASKS.md']!).find(t => t.title === 'Ranking semanal')?.context).toBe('por região')

  const band = await $.ui.mount({ plugin: 'tarefas', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'tarefa-ok' })
  expect(parseTasks(files['/proj/TASKS.md']!).find(t => t.title === 'Portar a esquiva para o FishNet')?.done).toBe(true)
})

test('/tarefas importar traz as pendências para Someday, sem repetir', async ($, on) => {
  const files: Record<string, string> = {
    '/proj/NOTAS.md': '## Pendente\n- **Som de ataque do monstro** não existe.\n',
    '/proj/docs/ROADMAP.md': '## Now\n- [ ] Tela de login\n',
    '/proj/README.md': '## TODO\n- não importar do README\n',
  }
  const { toasts } = project(on, files)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const run = () =>
    $.command.run({ command: 'tarefas', args: 'importar', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  await run()
  const tasks = parseTasks(files['/proj/TASKS.md']!)
  expect(tasks.map(t => [t.section, t.title])).toEqual([
    ['Someday', 'Som de ataque do monstro'],
    ['Someday', 'Tela de login'],
  ])
  expect(tasks[1]?.context).toBe('de docs/ROADMAP.md')
  await run()
  expect(toasts.at(-1)).toMatch(/Importei 0 pendências .*2 já existiam/)
})
