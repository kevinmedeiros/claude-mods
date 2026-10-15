import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { applyAddMarkdown, applyUpdateMarkdown, parseMarkdown } from '../hooks/markdown'
import { summarize } from '../hooks/roadmap'
import type { Roadmap } from '../types'

const MD = `# Lighthouse
Até o beta.
Dono: Sam

## Fase 1 · Protótipo
- [x] Tela inicial (2026-09-20 · commit abc123)

## Fase 2 · Beta fechado
> Gate: dez pessoas usando por uma semana
- [x] Sincronizar notas (2026-10-02)
- [ ] Login por e-mail @Claude (em andamento)
  - usar magic link
- [ ] Conta de desenvolvedor na loja @ambos (bloqueado: aprovação do cartão)
- [ ] Convidar os testadores @Sam (depois de: Login por e-mail) (gate)
- [ ] Modo escuro @Claude

### Visual
- [ ] Escolher o ícone @Sam

## Fase 3 · Lançamento
- [ ] Publicar na loja @ambos (depois de: Conta de desenvolvedor)

## Decisões
- Cobrar assinatura? (fase 3)

## Notas
Texto solto que não é fase.
`

const read = (text: string): Roadmap => {
  const parsed = parseMarkdown(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.roadmap
}

test('ROADMAP.md: fases, itens, donos, estados, dependências e decisões', () => {
  const r = read(MD)
  expect(r.project).toBe('Lighthouse')
  expect(r.goal).toBe('Até o beta.')
  expect(r.owner).toBe('Sam')
  expect(r.phases.map(p => [p.id, p.name, p.status])).toEqual([
    ['1', 'Protótipo', 'done'],
    ['2', 'Beta fechado', 'doing'],
    ['3', 'Lançamento', 'todo'],
  ])
  expect(r.phases[1]?.gate).toBe('dez pessoas usando por uma semana')
  const byId = Object.fromEntries(r.items.map(i => [i.id, i]))
  expect(byId['tela-inicial']).toMatchObject({ status: 'done', doneAt: '2026-09-20', evidence: 'commit abc123' })
  expect(byId['login-por-e-mail']).toMatchObject({ status: 'doing', owner: 'Claude', notes: 'usar magic link' })
  expect(byId['conta-de-desenvolvedor-na-loja']).toMatchObject({ status: 'blocked', owner: 'both', waitingOn: 'aprovação do cartão' })
  expect(byId['convidar-os-testadores']).toMatchObject({ dependsOn: ['login-por-e-mail'], gate: true })
  expect(byId['escolher-o-icone']).toMatchObject({ phase: '2', area: 'Visual' })
  expect(byId['publicar-na-loja']?.dependsOn).toEqual(['conta-de-desenvolvedor-na-loja'])
  expect(r.openDecisions).toEqual([{ title: 'Cobrar assinatura?', phase: '3' }])

  const s = summarize(r)
  expect(s.current?.phase.id).toBe('2')
  // 1 de 6 itens da fase 2.
  expect(s.current?.pct).toBe(16)
  expect(s.next.map(i => i.id)).toEqual(['login-por-e-mail', 'modo-escuro', 'escolher-o-icone'])
})

test('ROADMAP.md sem fases: tudo numa fase só; sem caixas: erro que explica o formato', () => {
  const r = read('# Coisas\n- [ ] Uma\n- [x] Outra\n')
  expect(r.phases.map(p => p.name)).toEqual(['Roadmap'])
  expect(r.items.map(i => i.status)).toEqual(['todo', 'done'])
  const bad = parseMarkdown('# Roadmap\n\n### T-001\n- status: todo\n')
  expect(bad.ok).toBe(false)
  expect(bad.ok ? '' : bad.error).toMatch(/## Fase 1 · Nome/)
  // Caixas dentro de bloco de código não contam.
  expect(parseMarkdown('```\n- [ ] exemplo\n```\n').ok).toBe(false)
})

test('roadmap_update no ROADMAP.md: muda só a linha do item e guarda data e evidência', () => {
  const done = applyUpdateMarkdown(MD, { id: 'login-por-e-mail', status: 'done', evidence: 'commit def456' }, '2026-10-15')
  if (!done.ok) throw new Error(done.error)
  expect(done.message).toBe('"Login por e-mail" → feito em 2026-10-15')
  const before = MD.split('\n')
  const after = done.text.split('\n')
  const changed = after.filter((l, n) => l !== before[n])
  expect(changed).toEqual(['- [x] Login por e-mail @Claude (2026-10-15 · commit def456)'])
  expect(read(done.text).items.find(i => i.id === 'login-por-e-mail')).toMatchObject({ status: 'done', doneAt: '2026-10-15', evidence: 'commit def456' })

  const blocked = applyUpdateMarkdown(MD, { id: 'modo-escuro', status: 'blocked', waitingOn: 'paleta nova' }, '2026-10-15')
  expect(blocked.ok && blocked.text).toContain('- [ ] Modo escuro @Claude (bloqueado: paleta nova)')
  const reopened = applyUpdateMarkdown(MD, { id: 'tela-inicial', status: 'todo' }, '2026-10-15')
  expect(reopened.ok && reopened.text).toContain('- [ ] Tela inicial\n')
  const noted = applyUpdateMarkdown(MD, { id: 'modo-escuro', note: 'falta o contraste' }, '2026-10-15')
  expect(noted.ok && noted.text).toContain('- [ ] Modo escuro @Claude\n  - falta o contraste\n')
  const phase = applyUpdateMarkdown(MD, { id: '2', status: 'done' }, '2026-10-15')
  expect(phase.ok && phase.text).toContain('## Fase 2 · Beta fechado (feita)')
  expect(phase.ok && read(phase.text).phases[1]?.status).toBe('done')

  const crlf = applyUpdateMarkdown(MD.replaceAll('\n', '\r\n'), { id: 'modo-escuro', status: 'doing' }, '2026-10-15')
  expect(crlf.ok && crlf.text).toContain('- [ ] Modo escuro @Claude (em andamento)\r\n')

  const missing = applyUpdateMarkdown(MD, { id: 'logon', status: 'done' }, '2026-10-15')
  expect(missing.ok ? '' : missing.error).toMatch(/Não existe item "logon"/)
  const short = applyUpdateMarkdown(MD, { id: 'modo-escuro', short: 'Escuro' }, '2026-10-15')
  expect(short.ok).toBe(false)
})

test('roadmap_add no ROADMAP.md: entra no fim da fase ou depois de "after", com dono e dependência', () => {
  const added = applyAddMarkdown(MD, { phase: '3', title: 'Página do produto', owner: 'Claude', dependsOn: ['publicar-na-loja'] }, '2026-10-15')
  if (!added.ok) throw new Error(added.error)
  expect(added.id).toBe('pagina-do-produto')
  expect(added.text).toContain('- [ ] Publicar na loja @ambos (depois de: Conta de desenvolvedor)\n- [ ] Página do produto @Claude (depois de: Publicar na loja)\n')
  expect(read(added.text).items.find(i => i.id === 'pagina-do-produto')).toMatchObject({ phase: '3', dependsOn: ['publicar-na-loja'] })

  const after = applyAddMarkdown(MD, { phase: '2', title: 'Testar o magic link', after: 'login-por-e-mail' }, '2026-10-15')
  // Depois do bloco do item (a sub-lista dele vem junto).
  expect(after.ok && after.text).toContain('  - usar magic link\n- [ ] Testar o magic link\n')
  const twin = applyAddMarkdown(MD, { phase: '2', title: 'Modo escuro' }, '2026-10-15')
  expect(twin.ok ? '' : twin.error).toMatch(/Já existe esse item/)
  const nophase = applyAddMarkdown(MD, { phase: '9', title: 'X' }, '2026-10-15')
  expect(nophase.ok ? '' : nophase.error).toMatch(/A fase "9" não existe/)
})

/** Um projeto com só o ROADMAP.md, sem git. */
const project = (on: On, files: Record<string, string>) => {
  mock.clock(on, { now: Date.parse('2026-10-15T12:00:00Z') })
  const toasts: string[] = []
  let tick = 0
  const mtimes: Record<string, number> = {}
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'ENOENT' }))
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    mtimes[e.path] = ++tick
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    e.path in files ? { value: { kind: 'file' as const, size: files[e.path]!.length, mtimeMs: mtimes[e.path] ?? 0, isLink: false } } : { deny: 'ENOENT' },
  )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__roadmap__${e.name}` } }))
  on('ui.toast', ($, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)

  return toasts
}

test('sem docs/roadmap.json, o mod acha o ROADMAP.md e o Claude marca nele', async ($, on) => {
  const files: Record<string, string> = { '/proj/ROADMAP.md': MD }
  const toasts = project(on, files)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'roadmap',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  expect(await band.find({ text: /16%/ })).toBeDefined()

  const done = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'modo-escuro', status: 'done' } as never)
  expect(done.result).toBe('"Modo escuro" → feito em 2026-10-15')
  expect(files['/proj/ROADMAP.md']).toContain('- [x] Modo escuro @Claude (2026-10-15)')
  expect(toasts.at(-1)).toBe('Claude atualizou o roadmap: "Modo escuro" → feito em 2026-10-15')
  expect(files['/proj/docs/roadmap.json']).toBeUndefined()
})
