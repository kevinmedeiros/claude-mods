import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  TEMPLATE,
  applyAdd,
  applyUpdate,
  bandBar,
  cardLabel,
  columnWidth,
  countsText,
  cut,
  formatJson,
  gateChip,
  itemLabel,
  kanban,
  layoutFor,
  mineCount,
  missingText,
  newlyDone,
  paneSvgWidth,
  parseRoadmap,
  phaseShort,
  phaseTitle,
  planBand,
  reportText,
  scanJson,
  searchItems,
  segBarSvg,
  slugify,
  splitBar,
  staleChip,
  staleCount,
  staleText,
  startPrompt,
  statusLine,
  summarize,
  trailAlt,
  trailSvg,
  trailText,
} from '../hooks/roadmap'
import type { Roadmap } from '../types'

// O roadmap de um app inventado, escrito à mão no formato que o mod grava,
// com campos que o mod não conhece ("estimate", "links") e que precisam sobreviver.
const TEXT = `{
  "version": 1,
  "project": "Farol",
  "goal": "até o beta",
  "updated": "2026-10-01",
  "owner": "Ana",
  "phases": [
    {
      "id": "1",
      "name": "Protótipo",
      "status": "done"
    },
    {
      "id": "2",
      "name": "Beta fechado",
      "goal": "dez pessoas usando",
      "status": "doing",
      "gate": "dez pessoas usam por uma semana",
      "gateStatus": "pendente"
    },
    {
      "id": "3",
      "name": "Lançamento",
      "status": "todo"
    }
  ],
  "items": [
    {
      "id": "tela-inicial",
      "phase": "1",
      "title": "Tela inicial",
      "status": "done",
      "owner": "Claude",
      "doneAt": "2026-09-20",
      "evidence": "commit abc123"
    },
    {
      "id": "sincronizar-notas",
      "phase": "2",
      "title": "Sincronizar notas",
      "status": "done",
      "owner": "Claude",
      "doneAt": "2026-10-02"
    },
    {
      "id": "login",
      "phase": "2",
      "title": "Login por e-mail",
      "status": "doing",
      "owner": "Claude",
      "dependsOn": ["sincronizar-notas"]
    },
    {
      "id": "convidar-testadores",
      "phase": "2",
      "title": "Convidar os testadores",
      "status": "todo",
      "owner": "Ana",
      "dependsOn": ["login"]
    },
    {
      "id": "icone",
      "phase": "2",
      "title": "Aprovar o ícone",
      "status": "todo",
      "owner": "ana"
    },
    {
      "id": "conta-loja",
      "phase": "2",
      "title": "Conta de desenvolvedor na loja",
      "status": "blocked",
      "owner": "both",
      "waitingOn": "aprovação do cartão"
    },
    {
      "id": "modo-escuro",
      "phase": "2",
      "title": "Modo escuro",
      "status": "todo",
      "owner": "Claude",
      "area": "interface",
      "estimate": "2d"
    },
    {
      "id": "publicar",
      "phase": "3",
      "title": "Publicar na loja",
      "status": "todo",
      "owner": "both",
      "dependsOn": ["conta-loja"],
      "gate": true
    },
    {
      "id": "pagina",
      "phase": "3",
      "title": "Página do produto",
      "status": "todo",
      "owner": "Claude"
    }
  ],
  "path": ["login", "modo-escuro", "icone"],
  "openDecisions": [
    {
      "title": "Cobrar assinatura?",
      "phase": "3",
      "ref": "docs/precos.md"
    }
  ],
  "links": {
    "board": "https://example.com/board"
  }
}
`

const TODAY = '2026-10-12'

const roadmap = (text: string | undefined): Roadmap => {
  if (text === undefined) throw new Error('sem texto')
  const parsed = parseRoadmap(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.roadmap
}

/** A linha em que o trecho aparece no texto. */
const lineOf = (text: string, needle: string) => text.slice(0, text.indexOf(needle)).split('\n').length

const errorOf = (text: string) => {
  const parsed = parseRoadmap(text)
  return parsed.ok ? 'ok' : parsed.error
}

test('lê o roadmap: fase atual, %, próximas na ordem do caminho, com você e esperando', () => {
  const r = roadmap(TEXT)
  const s = summarize(r)
  expect(s.current?.phase.id).toBe('2')
  expect([s.current?.done, s.current?.total, s.current?.pct]).toEqual([1, 6, 16])
  expect(s.phases.map(p => [p.phase.id, p.pct])).toEqual([
    ['1', 100],
    ['2', 16],
    ['3', 0],
  ])
  // Caminho primeiro (login, modo-escuro, icone), depois a ordem do arquivo; sem os que
  // esperam dependência (convidar-testadores, publicar) e sem os bloqueados.
  expect(s.next.map(i => i.id)).toEqual(['login', 'modo-escuro', 'icone', 'pagina'])
  // "Ana" e "ana" são o usuário; "both" também conta. Agora: livre e da fase atual;
  // depois: bloqueado ou esperando dependência; as outras fases só contam.
  expect(s.mineNow.map(i => i.id)).toEqual(['icone'])
  expect(s.mineLater.map(i => i.id)).toEqual(['convidar-testadores', 'conta-loja'])
  expect(s.mineElsewhere).toBe(1)
  expect(s.waiting.map(i => i.id)).toEqual(['conta-loja'])
  expect(s.waitingElsewhere).toBe(0)
  // A decisão é da fase 3: fica fora da lista da fase atual.
  expect([s.decisions, s.decisionsElsewhere]).toEqual([[], 1])
  expect(s.doneElsewhere.map(d => [d.phase.id, d.count])).toEqual([['1', 1]])
  expect(statusLine(s)).toBe('Fase 2 · 16%')
  expect(r.items.find(i => i.id === 'publicar')?.gate).toBe(true)
  expect(r.openDecisions).toEqual([{ title: 'Cobrar assinatura?', phase: '3', ref: 'docs/precos.md' }])
  // Com BOM no começo, lê igual.
  expect(parseRoadmap(`\uFEFF${TEXT}`).ok).toBe(true)
})

test('fase atual sem "doing" é a primeira não feita; tudo feito fica na última; no máximo 5 próximas', () => {
  const noDoing = roadmap(TEXT.replace('"status": "doing",\n      "gate"', '"status": "todo",\n      "gate"'))
  expect(summarize(noDoing).current?.phase.id).toBe('2')
  const allDone = roadmap(
    JSON.stringify({
      version: 1,
      phases: [
        { id: 'a', status: 'done' },
        { id: 'b', status: 'done' },
      ],
      items: [],
    }),
  )
  expect(summarize(allDone).current?.phase.id).toBe('b')
  // Fase sem itens: 100% se feita, 0% se não.
  expect(summarize(allDone).phases.map(p => p.pct)).toEqual([100, 100])
  const many = roadmap(
    JSON.stringify({
      version: 1,
      phases: [{ id: '1', status: 'doing' }],
      items: Array.from({ length: 8 }, (_, n) => ({ id: `i${n}`, phase: '1', title: `Item ${n}` })),
    }),
  )
  expect(summarize(many).next.map(i => i.id)).toEqual(['i0', 'i1', 'i2', 'i3', 'i4'])
  // Um item cuja dependência foi feita entra nas próximas.
  const unlocked = roadmap(TEXT.replace('"title": "Login por e-mail",\n      "status": "doing"', '"title": "Login por e-mail",\n      "status": "done"'))
  expect(summarize(unlocked).next.map(i => i.id)).toEqual(['modo-escuro', 'icone', 'convidar-testadores', 'pagina'])
  expect(summarize(unlocked).current?.pct).toBe(33)
})

test('JSON quebrado: a linha e o motivo', () => {
  expect(errorOf('{\n  "version": 1,\n  "project": "X"\n  "phases": []\n}')).toBe('linha 3, coluna 17: falta uma vírgula depois deste valor')
  expect(errorOf('{\n  "version": 1,\n  "phases": [],\n}')).toBe('linha 3, coluna 15: vírgula sobrando antes de "}"')
  expect(errorOf('{\n  "project": "X\n}')).toBe('linha 2, coluna 14: aspas sem fechar')
  expect(errorOf('{\n  // fases\n  "phases": []\n}')).toBe('linha 2, coluna 3: o JSON não aceita comentários')
  expect(errorOf("{\n  'phases': []\n}")).toBe('linha 2, coluna 3: use aspas duplas (") em vez de simples')
  expect(errorOf('{\n  "phases": [\n')).toBe('linha 2, coluna 13: falta fechar o colchete "[" aberto aqui')
  expect(errorOf('{ "a": 1 } x')).toBe('linha 1, coluna 12: texto sobrando depois do fim do JSON')
  expect(errorOf('  \n')).toBe('o arquivo está vazio')
  // Num JSON válido, o scanner sabe onde está cada valor.
  const scan = scanJson(TEXT)
  expect(scan.error).toBeUndefined()
  expect(lineOfOffset(TEXT, scan.at.get('/items/2/status')!)).toBe(lineOf(TEXT, '"status": "doing",\n      "owner": "Claude",\n      "dependsOn": ["sincronizar'))
})

const lineOfOffset = (text: string, offset: number) => text.slice(0, offset).split('\n').length

test('formato errado: a linha do campo e o motivo', () => {
  const status = TEXT.replace('"status": "blocked"', '"status": "travado"')
  expect(errorOf(status)).toBe(
    `linha ${lineOf(status, '"travado"')}: item "conta-loja": status "travado" inválido (use done, doing, todo ou blocked)`,
  )
  const phase = TEXT.replace('"phase": "3",\n      "title": "Página', '"phase": "9",\n      "title": "Página')
  expect(errorOf(phase)).toBe(`linha ${lineOf(phase, '"phase": "9"')}: item "pagina": a fase "9" não existe em "phases"`)
  const dep = TEXT.replace('["login"]', '["logon"]')
  expect(errorOf(dep)).toBe(`linha ${lineOf(dep, '"logon"')}: item "convidar-testadores" depende de "logon", que não existe`)
  const twin = TEXT.replace('"id": "pagina"', '"id": "publicar"')
  expect(errorOf(twin)).toBe(`linha ${lineOf(twin, '"id": "publicar",\n      "phase": "3",\n      "title": "Página')}: item "publicar" repetido`)
  const path = TEXT.replace('"icone"]', '"icon"]')
  expect(errorOf(path)).toBe(`linha ${lineOf(path, '"path"')}: "path" cita "icon", que não é id de nenhum item`)
  expect(errorOf(TEXT.replace('"version": 1', '"version": 2'))).toBe('linha 2: version 2 não suportada: este mod lê a versão 1')
  expect(errorOf('[]')).toBe('linha 1: o roadmap precisa ser um objeto JSON: { "version": 1, ... }')
  expect(errorOf('{ "phases": [{ "id": "1", "status": "feita" }] }')).toBe('linha 1: fase "1": status "feita" inválido (use done, doing ou todo)')
})

test('roadmap_update: "done" sem data usa hoje, e só as linhas que mudam mudam', () => {
  const r = applyUpdate(TEXT, { id: 'login', status: 'done', evidence: 'commit def456' }, TODAY)
  if (!r.ok) throw new Error(r.error)
  expect(r.message).toBe('"Login por e-mail" → feito em 2026-10-12')
  const before = '"status": "doing",\n      "owner": "Claude",\n      "dependsOn": ["sincronizar-notas"]\n'
  const after =
    '"status": "done",\n      "owner": "Claude",\n      "dependsOn": ["sincronizar-notas"],\n      "doneAt": "2026-10-12",\n      "evidence": "commit def456"\n'
  expect(r.text).toContain(after)
  expect(r.text.replace(after, before).replace('"updated": "2026-10-12"', '"updated": "2026-10-01"')).toBe(TEXT)
  // A ordem das chaves e os campos desconhecidos ficam.
  const doc = JSON.parse(r.text) as Record<string, unknown>
  expect(Object.keys(doc)).toEqual(['version', 'project', 'goal', 'updated', 'owner', 'phases', 'items', 'path', 'openDecisions', 'links'])
  expect((doc.items as Record<string, unknown>[])[6]?.estimate).toBe('2d')

  // Data dada pelo Claude; nota somada às notas.
  const dated = applyUpdate(TEXT, { id: 'modo-escuro', status: 'done', doneAt: '2026-10-11', note: 'tema do sistema' }, TODAY)
  expect(dated.ok && roadmap(dated.text).items.find(i => i.id === 'modo-escuro')).toMatchObject({ doneAt: '2026-10-11', notes: 'tema do sistema' })
  // Reabrir tira a data; a evidência fica.
  const reopened = applyUpdate(TEXT, { id: 'tela-inicial', status: 'doing' }, TODAY)
  const item = reopened.ok ? roadmap(reopened.text).items.find(i => i.id === 'tela-inicial') : undefined
  expect([item?.status, item?.doneAt, item?.evidence]).toEqual(['doing', undefined, 'commit abc123'])
  // Marcar de novo o que já estava feito não muda a data nem o arquivo.
  const again = applyUpdate(TEXT, { id: 'tela-inicial', status: 'done' }, TODAY)
  expect(again.ok && again.text === TEXT).toBe(true)
  // Bloquear com o que espera (a página é da fase 3: entra na contagem das outras fases).
  const blocked = applyUpdate(TEXT, { id: 'pagina', status: 'blocked', waitingOn: 'textos do marketing' }, TODAY)
  const late = blocked.ok ? roadmap(blocked.text) : undefined
  expect(late?.items.find(i => i.id === 'pagina')).toMatchObject({ status: 'blocked', waitingOn: 'textos do marketing' })
  expect(late && [summarize(late).waiting.map(i => i.id), summarize(late).waitingElsewhere]).toEqual([['conta-loja'], 1])
  // O id de uma fase muda a fase; "evidence" vira o resultado do gate.
  const phase = applyUpdate(TEXT, { id: '2', status: 'done', evidence: 'passou em 2026-10-12' }, TODAY)
  expect(phase.ok && phase.message).toBe('Fase 2 Beta fechado → feita')
  expect(phase.ok && roadmap(phase.text).phases[1]).toMatchObject({ status: 'done', gateStatus: 'passou em 2026-10-12' })
})

test('roadmap_update: mantém CRLF, tira o BOM e respeita a falta de quebra no fim', () => {
  const crlf = applyUpdate(TEXT.replaceAll('\n', '\r\n'), { id: 'icone', status: 'doing' }, TODAY)
  if (!crlf.ok) throw new Error(crlf.error)
  expect(crlf.text).toContain('"status": "doing",\r\n      "owner": "ana"')
  expect(/[^\r]\n/.test(crlf.text)).toBe(false)
  expect(crlf.text.endsWith('}\r\n')).toBe(true)
  const bom = applyUpdate(`\uFEFF${TEXT}`, { id: 'icone', status: 'doing' }, TODAY)
  expect(bom.ok && bom.text.charCodeAt(0)).toBe('{'.charCodeAt(0))
  const bare = applyUpdate(TEXT.trimEnd(), { id: 'icone', status: 'doing' }, TODAY)
  expect(bare.ok && bare.text.endsWith('}')).toBe(true)
})

test('roadmap_update recusa: id que não existe, status inválido, data errada e arquivo com erro', () => {
  expect(applyUpdate(TEXT, { id: 'tela', status: 'done' }, TODAY)).toEqual({
    ok: false,
    error: 'Não existe item "tela" no roadmap. Ids parecidos: tela-inicial.',
  })
  expect(applyUpdate(TEXT, { id: 'xyz', status: 'done' }, TODAY)).toEqual({
    ok: false,
    error: 'Não existe item "xyz" no roadmap. Use roadmap_status para ver os ids.',
  })
  expect(applyUpdate(TEXT, { id: 'login', status: 'feito' }, TODAY)).toEqual({
    ok: false,
    error: 'Status "feito" inválido: use done, doing, todo ou blocked.',
  })
  expect(applyUpdate(TEXT, { id: '2', status: 'blocked' }, TODAY)).toEqual({
    ok: false,
    error: 'Status "blocked" inválido para fase: use done, doing ou todo.',
  })
  expect(applyUpdate(TEXT, { id: 'login', status: 'done', doneAt: '12/10/2026' }, TODAY)).toEqual({
    ok: false,
    error: '"doneAt" precisa ser uma data AAAA-MM-DD (recebi "12/10/2026").',
  })
  const broken = TEXT.replace('"status": "blocked"', '"status": "travado"')
  const r = applyUpdate(broken, { id: 'login', status: 'done' }, TODAY)
  expect(r.ok ? '' : r.error).toMatch(/^O roadmap tem erro e não foi alterado \(linha \d+: item "conta-loja": status "travado"/)
})

test('roadmap_add: id do título sem repetir, entra depois de "after" no arquivo e no caminho', () => {
  const r = applyAdd(TEXT, { phase: '2', title: 'Tela de configurações', owner: 'Claude', after: 'login', dependsOn: ['login'] }, TODAY)
  if (!r.ok) throw new Error(r.error)
  expect(r.id).toBe('tela-de-configuracoes')
  expect(r.message).toBe('Item criado na Fase 2 Beta fechado: "Tela de configurações" (tela-de-configuracoes)')
  const added = roadmap(r.text)
  expect(added.items.map(i => i.id).slice(2, 5)).toEqual(['login', 'tela-de-configuracoes', 'convidar-testadores'])
  expect(added.items.find(i => i.id === 'tela-de-configuracoes')).toMatchObject({ phase: '2', status: 'todo', owner: 'Claude', dependsOn: ['login'] })
  expect(added.path).toEqual(['login', 'tela-de-configuracoes', 'modo-escuro', 'icone'])
  expect(added.updated).toBe(TODAY)
  expect(r.text).toContain(
    '{\n      "id": "tela-de-configuracoes",\n      "phase": "2",\n      "title": "Tela de configurações",\n      "status": "todo",\n      "owner": "Claude",\n      "dependsOn": ["login"]\n    }',
  )
  // Sem "after": fim da fase; o mesmo título em outra fase ganha outro id.
  const other = applyAdd(TEXT, { phase: '3', title: 'Modo escuro' }, TODAY)
  const late = other.ok ? roadmap(other.text) : undefined
  expect(other.ok && other.id).toBe('modo-escuro-2')
  expect(late?.items.at(-1)?.id).toBe('modo-escuro-2')
  expect(late?.path.at(-1)).toBe('modo-escuro-2')
  // Na fase 2 e sem "after": depois do último passo da fase no caminho.
  const mid = applyAdd(TEXT, { phase: '2', title: 'Ajuda dentro do app' }, TODAY)
  expect(mid.ok && roadmap(mid.text).path).toEqual(['login', 'modo-escuro', 'icone', 'ajuda-dentro-do-app'])
  expect(mid.ok && roadmap(mid.text).items.map(i => i.id).indexOf('ajuda-dentro-do-app')).toBe(7)
  // Nunca apaga item.
  expect(roadmap(r.text).items).toHaveLength(roadmap(TEXT).items.length + 1)
})

test('roadmap_add recusa: fase que não existe, item repetido na fase, dependência e "after" desconhecidos', () => {
  expect(applyAdd(TEXT, { phase: '9', title: 'X' }, TODAY)).toEqual({ ok: false, error: 'A fase "9" não existe. Fases: 1, 2, 3.' })
  expect(applyAdd(TEXT, { phase: '2', title: 'modo ESCURO!' }, TODAY)).toEqual({
    ok: false,
    error: 'Já existe esse item na Fase 2 Beta fechado: "Modo escuro" (modo-escuro).',
  })
  expect(applyAdd(TEXT, { phase: '2', title: 'Y', dependsOn: ['nada'] }, TODAY)).toMatchObject({ ok: false, error: expect.stringContaining('"dependsOn" cita "nada"') })
  expect(applyAdd(TEXT, { phase: '2', title: 'Y', after: 'logon' }, TODAY)).toMatchObject({ ok: false, error: expect.stringContaining('"after" cita "logon"') })
  expect(applyAdd(TEXT, { phase: '2', title: '  ' }, TODAY)).toEqual({ ok: false, error: 'Falta o "title" do item.' })
})

test('gravação: JSON com 2 espaços e listas curtas numa linha; id do título; textos de apoio', () => {
  expect(`${formatJson(JSON.parse(TEXT))}\n`).toBe(TEXT)
  const long = { path: Array.from({ length: 12 }, (_, n) => `passo-numero-${n}`) }
  expect(formatJson(long)).toBe(`{\n  "path": [\n${long.path.map(p => `    "${p}"`).join(',\n')}\n  ]\n}`)
  expect(formatJson({ a: [], b: {}, c: [1, null, true] })).toBe('{\n  "a": [],\n  "b": {},\n  "c": [1, null, true]\n}')
  expect(slugify('Configurar o ícone do app!')).toBe('configurar-o-icone-do-app')
  expect(slugify('???')).toBe('item')
  expect(slugify('Uma tarefa com um título comprido demais para virar id inteiro').length).toBeLessThanOrEqual(40)
  expect(staleText(14, 10)).toBe('roadmap desatualizado: 14 commits sem atualizar')
  expect([staleText(10, 10), staleText(50, 0), staleText(null, 10)]).toEqual([undefined, undefined, undefined])
  expect([cut('Curto', 10), cut('Um título comprido demais', 10), cut('Ação no 🎮 fim', 11)]).toEqual(['Curto', 'Um título…', 'Ação no 🎮…'])
})

// Escrito à mão num layout que o mod não usa: itens numa linha e listas em várias linhas.
const HAND = `{
  "version": 1,
  "project": "Farol",
  "owner": "Ana",
  "phases": [
    { "id": "1", "name": "Protótipo", "status": "done" },
    { "id": "2", "name": "Beta fechado", "status": "doing" }
  ],
  "items": [
    { "id": "tela-inicial", "phase": "1", "title": "Tela inicial", "status": "done", "owner": "Claude", "doneAt": "2026-09-20" },
    { "id": "login", "phase": "2", "title": "Login por e-mail", "status": "doing", "owner": "Claude" },
    {
      "id": "convidar",
      "phase": "2",
      "title": "Convidar os testadores",
      "status": "todo",
      "owner": "Ana",
      "dependsOn": [
        "login",
        "tela-inicial"
      ]
    }
  ],
  "path": [
    "login",
    "convidar"
  ]
}
`

/** As linhas (contadas de 1) que mudaram, num texto com o mesmo número de linhas. */
const changedLines = (a: string, b: string) => {
  const x = a.split('\n')
  const y = b.split('\n')
  return x.length === y.length ? x.flatMap((line, n) => (line === y[n] ? [] : [n + 1])) : `de ${x.length} para ${y.length} linhas`
}

const ok = (change: ReturnType<typeof applyUpdate>) => {
  if (!change.ok) throw new Error(change.error)
  return change.text
}

test('gravação no lugar: num arquivo escrito à mão, só muda o que mudou, no layout do arquivo', () => {
  // Item numa linha: a linha dele ganha os campos; o "updated" que faltava entra depois de "project".
  const done = ok(applyUpdate(HAND, { id: 'login', status: 'done', evidence: 'commit def456' }, TODAY))
  expect(done).toBe(
    HAND.replace('"project": "Farol",\n', '"project": "Farol",\n  "updated": "2026-10-12",\n').replace(
      '"status": "doing", "owner": "Claude" }',
      '"status": "done", "owner": "Claude", "doneAt": "2026-10-12", "evidence": "commit def456" }',
    ),
  )
  // Com "updated" no arquivo: só duas linhas mudam (a do item e a da data).
  const dated = HAND.replace('"project": "Farol",\n', '"project": "Farol",\n  "updated": "2026-10-01",\n')
  expect(changedLines(dated, ok(applyUpdate(dated, { id: 'login', status: 'done' }, TODAY)))).toEqual([4, 12])
  // Reabrir tira a data da linha do item.
  expect(ok(applyUpdate(dated, { id: 'tela-inicial', status: 'todo' }, TODAY))).toContain(
    '{ "id": "tela-inicial", "phase": "1", "title": "Tela inicial", "status": "todo", "owner": "Claude" },',
  )
  // Item em várias linhas: a lista de dependências continua em várias linhas; a nota entra numa linha nova.
  const noted = ok(applyUpdate(dated, { id: 'convidar', status: 'doing', note: 'lista pronta' }, TODAY))
  expect(noted).toContain('      "status": "doing",\n')
  expect(noted).toContain('      "dependsOn": [\n        "login",\n        "tela-inicial"\n      ],\n      "notes": "lista pronta"\n    }')
  expect(changedLines(dated, noted)).toBe('de 30 para 31 linhas')
  // Fase numa linha.
  expect(ok(applyUpdate(dated, { id: '2', status: 'done', evidence: 'ok' }, TODAY))).toContain(
    '{ "id": "2", "name": "Beta fechado", "status": "done", "gateStatus": "ok" }',
  )
  // Com CRLF, o que entra usa CRLF.
  const crlf = ok(applyUpdate(dated.replaceAll('\n', '\r\n'), { id: 'convidar', status: 'doing', note: 'x' }, TODAY))
  expect(/[^\r]\n/.test(crlf)).toBe(false)
})

test('gravação no lugar: item novo segue os vizinhos, e o caminho em várias linhas ganha uma linha', () => {
  // Depois de um item de uma linha: o novo também tem uma linha.
  const r = applyAdd(HAND, { phase: '2', title: 'Modo escuro', owner: 'Claude', after: 'login' }, TODAY)
  if (!r.ok) throw new Error(r.error)
  expect(r.text).toBe(
    HAND.replace('"project": "Farol",\n', '"project": "Farol",\n  "updated": "2026-10-12",\n')
      .replace(
        '"status": "doing", "owner": "Claude" },\n',
        '"status": "doing", "owner": "Claude" },\n    { "id": "modo-escuro", "phase": "2", "title": "Modo escuro", "status": "todo", "owner": "Claude" },\n',
      )
      .replace('    "login",\n    "convidar"', '    "login",\n    "modo-escuro",\n    "convidar"'),
  )
  // Depois de um item de várias linhas (fim da fase): o novo também, com dependsOn curto numa linha.
  const end = applyAdd(HAND, { phase: '2', title: 'Página', dependsOn: ['login'] }, TODAY)
  if (!end.ok) throw new Error(end.error)
  expect(end.text).toContain(
    '      ]\n    },\n    {\n      "id": "pagina",\n      "phase": "2",\n      "title": "Página",\n      "status": "todo",\n      "dependsOn": ["login"]\n    }\n  ],',
  )
  expect(end.text).toContain('    "convidar",\n    "pagina"\n  ]')
  // Na fase 1, antes de tudo: entra depois do último item da fase 1, numa linha.
  const first = applyAdd(HAND, { phase: '1', title: 'Logo' }, TODAY)
  expect(first.ok && first.text).toContain('"doneAt": "2026-09-20" },\n    { "id": "logo", "phase": "1", "title": "Logo", "status": "todo" },\n')
})

test('gravação: quando não dá para mudar no lugar (campo repetido), grava o arquivo inteiro no layout do mod', () => {
  const twice = HAND.replace('"status": "doing", "owner": "Claude" }', '"status": "doing", "status": "doing", "owner": "Claude" }')
  const text = ok(applyUpdate(twice, { id: 'login', status: 'done' }, TODAY))
  expect(text).toContain('{\n      "id": "login",\n      "phase": "2",\n      "title": "Login por e-mail",\n      "status": "done",')
  expect(roadmap(text).items.find(i => i.id === 'login')?.status).toBe('done')
})

test('o pedido de "Fazer a próxima": um texto para o Claude, um para o usuário e um para os dois, com as notas', () => {
  const r = roadmap(TEXT)
  const item = (id: string) => r.items.find(i => i.id === id)!
  // Do Claude, a fazer: em andamento ao começar, feito ao terminar.
  expect(startPrompt(item('modo-escuro'), r)).toBe(
    'Faça a tarefa "Modo escuro" (modo-escuro) do roadmap: marque como em andamento no roadmap (roadmap_update) ao começar e, ao terminar, como feita, com a evidência do que foi feito.',
  )
  // Do Claude, já em andamento.
  expect(startPrompt(item('login'), r)).toBe(
    'Continue a tarefa "Login por e-mail" (login) do roadmap, que já está em andamento. Ao terminar, marque como feita no roadmap (roadmap_update), com a evidência do que foi feito.',
  )
  // Do usuário: o Claude ajuda, e só marca feita quando o usuário disser.
  expect(startPrompt(item('icone'), r)).toBe(
    'Me ajude com a tarefa "Aprovar o ícone" (icone) do roadmap, que é minha: diga o que eu preciso fazer, passo a passo. Marque como em andamento no roadmap (roadmap_update) agora e, quando eu disser que terminei, como feita, com a evidência.',
  )
  // Bloqueado, ou à espera de outra tarefa: ver o que falta, sem começar.
  expect(startPrompt(item('conta-loja'), r)).toBe(
    'A tarefa "Conta de desenvolvedor na loja" (conta-loja) do roadmap está bloqueada, esperando aprovação do cartão. Veja se já dá para destravar e me diga o que falta e com quem está. Não comece a tarefa; se o bloqueio já tiver saído, marque como a fazer no roadmap (roadmap_update), com uma nota do que mudou.',
  )
  expect(startPrompt(item('convidar-testadores'), r)).toBe(
    'A tarefa "Convidar os testadores" (convidar-testadores) do roadmap depende de "Login por e-mail" (login), que ainda não está feita. Me diga o que falta para ela ficar livre (o que essa tarefa espera e com quem está). Não comece esta tarefa antes disso.',
  )
  // De "both": cada um faz a sua parte, e feita só com as duas prontas.
  const both =roadmap(TEXT.replace('"waitingOn": "aprovação do cartão"', '"notes": "precisa do cartão da empresa"').replace('"status": "blocked"', '"status": "todo"'))
  const store = both.items.find(i => i.id === 'conta-loja')!
  expect(startPrompt(store, both)).toBe(
    'Vamos fazer a tarefa "Conta de desenvolvedor na loja" (conta-loja) do roadmap, que é minha e sua: marque como em andamento no roadmap (roadmap_update) ao começar, faça a sua parte e me diga, passo a passo, o que é comigo. Só marque como feita, com a evidência, quando as duas partes estiverem prontas. Notas do item: precisa do cartão da empresa',
  )
  // Sem as ferramentas de escrita, o pedido não cita roadmap_update; notas longas são cortadas.
  const long = { ...store, status: 'doing' as const, notes: 'x'.repeat(500) }
  const text = startPrompt(long, both, false)
  expect(text).toMatch(/^Vamos continuar a tarefa .* Só marque como feita no roadmap, com a evidência, quando as duas partes estiverem prontas\. Notas do item: x+…$/)
  expect(text).not.toContain('roadmap_update')
  expect(text.length).toBeLessThan(500)
})

test('sem roadmap: o modelo é um roadmap válido e cada campo é explicado', () => {
  const r = roadmap(TEMPLATE)
  expect(r.items.map(i => i.owner)).toEqual(['Claude', '<nome do usuário>', 'both'])
  expect(r.items.find(i => i.status === 'blocked')?.waitingOn).toBe('aprovação')
  expect(r.items.at(-1)).toMatchObject({ dependsOn: ['primeiro-passo'], gate: true })
  expect(r.openDecisions).toHaveLength(1)
  const text = missingText('docs/roadmap.json')
  expect(text).toContain(TEMPLATE)
  for (const field of ['dependsOn', 'waitingOn', '"both"', 'gate', 'gateStatus', 'evidence', 'doneAt', 'area', 'notes', 'path', 'openDecisions']) {
    expect(text, field).toContain(field)
  }
  expect(text).toContain('o mesmo owner da raiz')
})

// ---------- rótulo curto e quadro ----------

test('rótulo curto ("short"): opcional e conferido; sem ele, o título cortado em 40 e o nome da fase em 18', () => {
  const r = roadmap(TEXT)
  const loja = r.items.find(i => i.id === 'conta-loja')!
  expect(loja.short).toBeUndefined()
  expect(itemLabel(loja)).toBe('Conta de desenvolvedor na loja')
  const long = { ...loja, title: 'Criar a conta de desenvolvedor na loja de aplicativos com o cartão da empresa' }
  expect(itemLabel(long)).toBe('Criar a conta de desenvolvedor na loja…')
  expect(Array.from(itemLabel(long)).length).toBeLessThanOrEqual(40)
  expect(itemLabel({ ...long, short: 'Conta na loja' })).toBe('Conta na loja')
  // O corte cai no fim de uma palavra quando isso não perde mais da metade.
  expect(itemLabel({ ...loja, title: 'Configurar o servidor de e-mail transacional da empresa' })).toBe('Configurar o servidor de e-mail…')
  expect(itemLabel({ ...loja, title: 'Configuraçãodoservidordee-mailtransacional' })).toBe('Configuraçãodoservidordee-mailtransacio…')
  const beta = r.phases[1]!
  expect([phaseShort(beta), phaseTitle(beta)]).toEqual(['Beta fechado', 'Fase 2 · Beta fechado'])
  expect(phaseShort({ ...beta, name: 'Beta fechado com dez pessoas de fora' })).toBe('Beta fechado com…')
  expect(phaseTitle({ ...beta, short: 'Beta' })).toBe('Fase 2 · Beta')
  expect(phaseTitle({ ...beta, name: '' })).toBe('Fase 2')

  // No arquivo: lido sem os espaços das pontas; vazio, longo demais ou não texto é erro, com a linha.
  const withShort = TEXT.replace('"title": "Conta de desenvolvedor na loja",', '"title": "Conta de desenvolvedor na loja",\n      "short": " Conta na loja ",')
  expect(roadmap(withShort).items.find(i => i.id === 'conta-loja')?.short).toBe('Conta na loja')
  const at = lineOf(TEXT, '"title": "Modo escuro"') + 1
  const bad = (short: string) => errorOf(TEXT.replace('"title": "Modo escuro",', `"title": "Modo escuro",\n      "short": ${short},`))
  expect(bad('""')).toBe(`linha ${at}: item "modo-escuro": "short" está vazio (tire o campo ou escreva um rótulo curto)`)
  expect(bad('3')).toBe(`linha ${at}: item "modo-escuro": "short" precisa ser um texto`)
  expect(bad(JSON.stringify('x'.repeat(61)))).toBe(`linha ${at}: item "modo-escuro": "short" tem 61 caracteres; o máximo é 60 (o ideal é até 40)`)
  expect(bad(JSON.stringify('x'.repeat(60)))).toBe('ok')
  expect(errorOf(TEXT.replace('"name": "Lançamento",', '"name": "Lançamento",\n      "short": "",'))).toBe(
    `linha ${lineOf(TEXT, '"name": "Lançamento"') + 1}: fase "3": "short" está vazio (tire o campo ou escreva um rótulo curto)`,
  )
  // Na fase, o ideal é até 18: é o nome na trilha.
  expect(errorOf(TEXT.replace('"name": "Lançamento",', `"name": "Lançamento",\n      "short": ${JSON.stringify('x'.repeat(61))},`))).toBe(
    `linha ${lineOf(TEXT, '"name": "Lançamento"') + 1}: fase "3": "short" tem 61 caracteres; o máximo é 60 (o ideal é até 18)`,
  )
})

test('short pelas ferramentas: o update põe, troca e tira; o add aceita; a busca e o resumo falam dele', () => {
  const set = applyUpdate(TEXT, { id: 'conta-loja', short: 'Conta na loja' }, TODAY)
  if (!set.ok) throw new Error(set.error)
  expect(set.message).toBe('"Conta de desenvolvedor na loja" → rótulo "Conta na loja"')
  // Gravado no lugar, logo depois do título; o resto do arquivo fica como estava.
  expect(set.text).toBe(
    TEXT.replace('"updated": "2026-10-01"', `"updated": "${TODAY}"`).replace(
      '"title": "Conta de desenvolvedor na loja",',
      '"title": "Conta de desenvolvedor na loja",\n      "short": "Conta na loja",',
    ),
  )
  const both = applyUpdate(set.text, { id: 'conta-loja', status: 'todo', short: 'Loja' }, TODAY)
  expect(both.ok && both.message).toBe('"Conta de desenvolvedor na loja" → a fazer · rótulo "Loja"')
  for (const empty of ['', null]) {
    const removed = applyUpdate(set.text, { id: 'conta-loja', short: empty }, TODAY)
    if (!removed.ok) throw new Error(removed.error)
    expect(removed.message).toBe('"Conta de desenvolvedor na loja" → sem rótulo curto')
    expect(removed.text).not.toContain('"short"')
    expect(roadmap(removed.text).items.find(i => i.id === 'conta-loja')).toMatchObject({ status: 'blocked', waitingOn: 'aprovação do cartão' })
  }
  expect(applyUpdate(TEXT, { id: 'icone', short: 'x'.repeat(61) }, TODAY)).toEqual({
    ok: false,
    error: '"short" tem 61 caracteres; o máximo é 60 (o ideal é até 40).',
  })
  expect(applyUpdate(TEXT, { id: 'icone', short: 5 }, TODAY)).toEqual({ ok: false, error: '"short" precisa ser um texto.' })
  // Numa fase: o rótulo da trilha, sem mexer no estado.
  const phase = applyUpdate(TEXT, { id: '2', short: 'Beta' }, TODAY)
  if (!phase.ok) throw new Error(phase.error)
  expect(phase.message).toBe('Fase 2 Beta fechado → rótulo "Beta"')
  expect(roadmap(phase.text).phases[1]).toMatchObject({ short: 'Beta', status: 'doing' })
  expect(applyUpdate(TEXT, { id: '3', short: 'x'.repeat(61) }, TODAY)).toEqual({ ok: false, error: '"short" tem 61 caracteres; o máximo é 60 (o ideal é até 18).' })
  // Só o short: o estado e a data do item feito ficam como estavam, e só a linha nova entra.
  const onlyShort = applyUpdate(TEXT, { id: 'sincronizar-notas', short: 'Sync' }, TODAY)
  if (!onlyShort.ok) throw new Error(onlyShort.error)
  expect(roadmap(onlyShort.text).items.find(i => i.id === 'sincronizar-notas')).toMatchObject({ status: 'done', doneAt: '2026-10-02', short: 'Sync' })
  expect(onlyShort.text).toBe(
    TEXT.replace('"updated": "2026-10-01"', `"updated": "${TODAY}"`).replace('"title": "Sincronizar notas",', '"title": "Sincronizar notas",\n      "short": "Sync",'),
  )
  expect(applyUpdate(TEXT, { id: 'icone', doneAt: '2026-10-05' }, TODAY)).toEqual({ ok: false, error: '"doneAt" só vale para item feito: passe status "done" junto.' })
  // A busca acha pelo short.
  const vitrine = roadmap(TEXT.replace('"title": "Página do produto",', '"title": "Página do produto",\n      "short": "Vitrine",'))
  expect(searchItems(vitrine, 'vitrine').items.map(i => i.id)).toEqual(['pagina'])
  // O resumo avisa da fase com nome longo e sem short.
  expect(reportText(roadmap(TEXT.replace('"name": "Lançamento"', '"name": "Lançamento para todo mundo"')), 'x')).toContain(
    'Fase com rótulo de mais de 18 caracteres (3): a trilha das fases corta o nome. Um "short" de até 18 na fase resolve.',
  )

  const added = applyAdd(TEXT, { phase: '2', title: 'Escrever a política de privacidade do aplicativo para a loja', short: 'Política de privacidade' }, TODAY)
  if (!added.ok) throw new Error(added.error)
  expect(roadmap(added.text).items.find(i => i.id === added.id)).toMatchObject({ short: 'Política de privacidade', status: 'todo' })
  expect(applyAdd(TEXT, { phase: '2', title: 'Outra', short: ' ' }, TODAY)).toMatchObject({ ok: true })
  expect(applyAdd(TEXT, { phase: '2', title: 'Outra', short: 'x'.repeat(70) }, TODAY)).toMatchObject({ ok: false, error: expect.stringContaining('"short" tem 70 caracteres') })

  // A busca mostra o rótulo; o resumo avisa dos títulos longos sem rótulo na fase atual.
  expect(reportText(roadmap(set.text), 'x', undefined, { query: 'loja' })).toContain('[conta-loja] Conta de desenvolvedor na loja (você e Claude; bloqueado; fase 2; espera: aprovação do cartão; rótulo: Conta na loja)')
  const longTitle = TEXT.replace('"title": "Login por e-mail"', '"title": "Login por e-mail com link mágico e confirmação em duas etapas"')
  expect(reportText(roadmap(longTitle), 'x')).toContain('1 item da fase atual sem "short" e com título de mais de 40 caracteres: o quadro mostra o título cortado.')
  expect(reportText(roadmap(TEXT), 'x')).not.toContain('sem "short"')
})

test('quadro: Agora, Próximas, Esperando e Feito; filtro Comigo; +N; layout pela largura', () => {
  const r = roadmap(TEXT)
  const kb = kanban(r, { width: 120 })
  expect([kb.layout, kb.columnWidth, kb.mine, kb.filter]).toEqual(['row', 29, 3, 'all'])
  // Esperando: os bloqueados e depois os que esperam outra tarefa (convidar-testadores espera o login).
  expect(kb.columns.map(c => [c.title, c.total, c.cards.map(k => k.id), c.more])).toEqual([
    ['Agora', 1, ['login'], 0],
    ['Próximas', 3, ['modo-escuro', 'icone', 'pagina'], 0],
    ['Esperando', 2, ['conta-loja', 'convidar-testadores'], 0],
    ['Feito', 1, ['sincronizar-notas'], 0],
  ])
  const card = (id: string) => kb.columns.flatMap(c => c.cards).find(k => k.id === id)
  expect(card('pagina')).toMatchObject({ label: 'Página do produto', owner: 'claude', ownerText: 'Claude', isOtherPhase: true, phase: '3' })
  expect(card('conta-loja')).toMatchObject({ owner: 'both', ownerText: 'os dois', wait: 'aprovação do cartão', waitKind: 'blocked', isOtherPhase: false })
  expect(card('convidar-testadores')).toMatchObject({ owner: 'me', wait: 'Login por e-mail', waitKind: 'dep' })
  expect(card('icone')).toMatchObject({ owner: 'me', ownerText: 'você', gate: false })
  // Comigo: só os do usuário e os de "both" (o mesmo número do "comigo: N" da faixa).
  const mine = kanban(r, { width: 120, filter: 'mine' })
  expect(mine.columns.map(c => c.cards.map(k => k.id))).toEqual([[], ['icone'], ['conta-loja', 'convidar-testadores'], []])
  expect([mine.filter, mine.mine, mineCount(r)]).toEqual(['mine', 3, 3])
  // Em andamento de outra fase também entra no Agora, depois dos da fase atual.
  const twoDoing = roadmap(TEXT.replace('"title": "Página do produto",\n      "status": "todo"', '"title": "Página do produto",\n      "status": "doing"'))
  expect(kanban(twoDoing, { width: 120 }).columns[0]!.cards.map(k => [k.id, k.isOtherPhase])).toEqual([
    ['login', false],
    ['pagina', true],
  ])
  // Feito: os últimos primeiro. No mesmo dia, vale quando o mod viu o item virar feito; sem isso, a ordem do arquivo, de baixo para cima.
  const sameDay = roadmap(
    JSON.stringify({
      version: 1,
      phases: [{ id: '1', status: 'doing' }],
      items: [
        { id: 'a', phase: '1', title: 'A', status: 'done', doneAt: TODAY },
        { id: 'velho', phase: '1', title: 'Velho', status: 'done', doneAt: '2026-10-01' },
        { id: 'b', phase: '1', title: 'B', status: 'done', doneAt: TODAY },
        { id: 'c', phase: '1', title: 'C', status: 'done', doneAt: TODAY },
        { id: 'd', phase: '1', title: 'D' },
      ],
    }),
  )
  expect(kanban(sameDay, { width: 120 }).columns[3]!.cards.map(k => k.id)).toEqual(['c', 'b', 'a'])
  expect(kanban(sameDay, { width: 120, seen: { a: 2, b: 1 } }).columns[3]!.cards.map(k => k.id)).toEqual(['a', 'b', 'c'])
  expect(kanban(sameDay, { width: 120 }).columns[3]!.more).toBe(1)
  // O mod anota quando vê um item virar feito.
  const before = roadmap(TEXT)
  const after = roadmap(TEXT.replace('"title": "Aprovar o ícone",\n      "status": "todo"', '"title": "Aprovar o ícone",\n      "status": "done"'))
  expect(newlyDone(before, after)).toEqual(['icone'])
  expect(newlyDone(after, after)).toEqual([])
  // Bloqueado sem waitingOn: espera a primeira dependência aberta.
  const dep = roadmap(
    JSON.stringify({
      version: 1,
      phases: [{ id: '1', status: 'doing' }],
      items: [
        { id: 'a', phase: '1', title: 'Contrato assinado' },
        { id: 'b', phase: '1', title: 'Publicar', status: 'blocked', dependsOn: ['a'] },
      ],
    }),
  )
  expect(kanban(dep, { width: 80 }).columns[2]?.cards[0]?.wait).toBe('Contrato assinado')

  expect([layoutFor(120), layoutFor(96), layoutFor(95), layoutFor(60), layoutFor(59), layoutFor(40)]).toEqual(['row', 'row', 'grid', 'grid', 'stack', 'stack'])
  expect([columnWidth('row', 120), columnWidth('row', 100), columnWidth('grid', 70), columnWidth('stack', 40)]).toEqual([29, 24, 34, 40])

  // Até 4 cartões (Feito, 3); cada "+N" abre mais 8, até a coluna inteira.
  const big = roadmap(bigText())
  const closed = kanban(big, { width: 120 })
  const next = closed.columns[1]!
  expect(next.total).toBeGreaterThan(20)
  expect([next.cards.length, next.more, next.isExpanded]).toEqual([4, next.total - 4, false])
  expect([closed.columns[3]!.cards.length, closed.columns[3]!.more]).toEqual([3, closed.columns[3]!.total - 3])
  const opened = (steps: number) => kanban(big, { width: 120, expanded: { next: steps } }).columns[1]!
  expect([opened(1).cards.length, opened(1).more, opened(1).isExpanded]).toEqual([12, next.total - 12, true])
  expect(opened(2).cards.length).toBe(20)
  expect([opened(99).cards.length, opened(99).more, opened(99).isExpanded]).toEqual([next.total, 0, true])
  // Coluna que cabe inteira não "abre".
  expect(kanban(r, { width: 120, expanded: { next: 1 } }).columns[1]!.isExpanded).toBe(false)
  // Sem short, o cartão traz o título cortado em 40.
  expect(next.cards[0]!.label).toBe(itemLabel(big.items.find(i => i.id === next.cards[0]!.id)!))
})

test('desenho: barra segmentada, contagens, trilha (texto e SVG) e a faixa cabendo numa linha', () => {
  const c = { done: 49, doing: 3, blocked: 12, todo: 49, total: 113 }
  expect(countsText(c)).toBe('49 ✓  3 ▶  12 ‖  49 ○')
  expect(splitBar(c, 40)).toEqual({ done: 18, doing: 1, blocked: 4, rest: 17 })
  expect(splitBar({ done: 0, doing: 0, blocked: 0, todo: 0, total: 0 }, 10)).toEqual({ done: 0, doing: 0, blocked: 0, rest: 10 })
  expect(splitBar({ done: 2, doing: 0, blocked: 0, todo: 0, total: 2 }, 10)).toEqual({ done: 10, doing: 0, blocked: 0, rest: 0 })
  expect(bandBar(43)).toEqual({ full: '▰▰▰▰', empty: '▱▱▱▱▱▱' })
  expect(bandBar(100)).toEqual({ full: '▰'.repeat(10), empty: '' })
  const bar = segBarSvg(c, 100)
  expect(bar).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 8"/)
  expect(bar).toContain('<rect width="43.4" height="8" fill="#3fa66a"/>')

  const views = summarize(roadmap(TEXT)).phases
  const t = trailText(views, 100)
  // Cabe tudo numa linha: "id nome", em slots iguais.
  expect(t.nodes.map(n => n.text).join('')).toBe(`●${'━'.repeat(32)}◉ 16% ${'━'.repeat(27)}○`)
  expect(t.labels.map(l => l.map(n => n.text).join(''))).toEqual([`${'1 Protótipo'.padEnd(33)}${'2 Beta fechado'.padEnd(33)}3 Lançamento`])
  expect(t.nodes.filter(n => n.tone === 'current').map(n => n.text)).toEqual(['◉', ' 16% '])
  // Fases demais para a largura: uma janela em volta da atual, com "…" nas pontas.
  const many = summarize(
    roadmap(
      JSON.stringify({
        version: 1,
        phases: Array.from({ length: 12 }, (_, n) => ({ id: String(n + 1), name: `Etapa ${n + 1}`, status: n < 6 ? 'done' : n === 6 ? 'doing' : 'todo' })),
        items: [],
      }),
    ),
  ).phases
  const w = trailText(many, 40)
  const line = w.nodes.map(n => n.text).join('')
  expect(line.startsWith('… ')).toBe(true)
  expect(line.endsWith(' …')).toBe(true)
  expect(line).toContain('◉')
  expect(Array.from(line).length).toBeLessThanOrEqual(40)
  expect(w.labels.flat().find(l => l.tone === 'current')?.text.trim()).toBe('Etapa 7')

  // SVG: um stepper; o número da fase vai dentro do nó e o nome embaixo; o % ao lado do nó atual.
  const svg = trailSvg(views, 400)
  expect(svg).toContain('viewBox="0 0 400 54"')
  expect(svg).toContain('fill="#fff">2</text>')
  expect(svg).toContain('>Beta fechado</text>')
  expect(svg).toContain('>16%</text>')
  expect(trailSvg(summarize(roadmap(TEXT.replace('"name": "Lançamento"', '"name": "<Lançamento>"'))).phases, 400)).toContain('>&lt;Lançamento&gt;</text>')
  expect(trailAlt(views)).toBe('Fases: 1 Protótipo feita; 2 Beta fechado atual, 16%; 3 Lançamento a fazer')

  // Sete fases com rótulos de até 18: em 120 colunas, nenhum nome cortado, no texto e no SVG.
  // A fase 6 está em andamento sem ser a atual: ◐ no texto, anel no SVG.
  const names = ['Protótipo de telas', 'Base e três regras', 'Conteúdo da versão', 'Economia e balanço', 'Testes com o grupo', 'Infra e lançamento', 'Suporte e correção']
  const seven = summarize(
    roadmap(
      JSON.stringify({
        version: 1,
        phases: names.map((name, n) => ({ id: String(n + 1), name, status: n < 2 ? 'done' : n === 2 || n === 5 ? 'doing' : 'todo' })),
        items: [],
      }),
    ),
  ).phases
  const t7 = trailText(seven, 120)
  const text7 = t7.labels.map(l => l.map(s => s.text).join('')).join('\n')
  expect(text7).not.toContain('…')
  for (const word of names.join(' ').split(' ')) expect(text7).toContain(word)
  expect(t7.nodes.map(n => n.text).join('')).toBe(
    `●${'━'.repeat(16)}●${'━'.repeat(16)}◉ 0% ${'━'.repeat(12)}○${'━'.repeat(16)}○${'━'.repeat(16)}◐${'━'.repeat(16)}○`,
  )
  for (const line of [t7.nodes, ...t7.labels]) expect(Array.from(line.map(s => s.text).join('')).length).toBeLessThanOrEqual(120)
  const svg7 = trailSvg(seven, paneSvgWidth(120))
  expect(svg7).not.toContain('…')
  expect(svg7).toContain('stroke="#d97757" stroke-width="2.5"/>')
  // Mais estreita: o nome é cortado com "…", mas nenhuma palavra é partida em duas linhas.
  const known = new Set(names.join(' ').split(' '))
  for (const width of [40, 56, 70, 90]) {
    const pieces = trailText(seven, width)
      .labels.flatMap(l => l.map(s => s.text))
      .join(' ')
      .split(/ +/)
      .filter(Boolean)
    for (const p of pieces) expect(known.has(p) || p.endsWith('…'), `largura ${width}: "${p}"`).toBe(true)
  }

  // O rótulo do cartão: até 2 linhas na largura, quebrado por palavra; o resto vira "…".
  expect(cardLabel('Modo escuro', 20)).toBe('Modo escuro')
  expect(cardLabel('Conferir o build novo no cliente de teste', 20)).toBe('Conferir o build novo no cliente de…')
  expect(cardLabel('Configuraçãodoservidordecorreio eletrônico', 12)).toBe('Configuraçãodoservidord…')
  // O chip do gate: o estado até a primeira pontuação, em até 16; estreito, só "Gate N".
  const beta = roadmap(TEXT).phases[1]!
  expect([gateChip(beta), gateChip(beta, true), gateChip(roadmap(TEXT).phases[0]!)]).toEqual(['Gate 2 · pendente', 'Gate 2', undefined])
  expect(gateChip({ ...beta, gateStatus: 'não rodado. Falta o roteiro' })).toBe('Gate 2 · não rodado')
  expect(gateChip({ ...beta, gateStatus: 'esperando os dez testadores' })).toBe('Gate 2 · esperando os de…')

  // A faixa: o rótulo da próxima cabe inteiro; para isso saem, nesta ordem, o aviso, o
  // "comigo: N", o dono, a barrinha, a moldura dos botões e o "Fase N". Só então ele encolhe.
  const stale = '⚠ 14 commits sem atualizar'
  const band = (width: number) =>
    planBand({ width, head: 'Fase 2', pct: '16%', hasBar: true, label: 'Login por e-mail', hasNext: true, owner: 'Claude', mine: 'comigo: 1', stale, hide: 'ocultar' })
  const all = { showHead: true, bar: true, framed: true, label: 'Login por e-mail', showOwner: true, showMine: true, showStale: true }
  expect(band(120)).toEqual(all)
  expect(band(100)).toEqual({ ...all, showStale: false })
  expect(band(85)).toEqual({ ...all, showStale: false, showMine: false })
  expect(band(75)).toEqual({ ...all, showStale: false, showMine: false, showOwner: false })
  expect(band(65)).toEqual({ ...all, showStale: false, showMine: false, showOwner: false, bar: false })
  expect(band(50)).toEqual({ ...all, showStale: false, showMine: false, showOwner: false, bar: false, framed: false })
  expect(band(45)).toEqual({ ...all, showStale: false, showMine: false, showOwner: false, bar: false, framed: false, showHead: false })
  expect(band(30).label).toBe('Logi…')
  // Numa faixa mais larga, nada some e o rótulo nunca fica menor.
  const shownAt = (w: number) => {
    const p = band(w)
    return [p.showHead, p.bar, p.framed, p.showOwner, p.showMine, p.showStale].filter(Boolean).length * 100 + Array.from(p.label).length
  }
  for (let w = 20; w < 140; w++) expect(shownAt(w + 1)).toBeGreaterThanOrEqual(shownAt(w))
  expect([staleCount(14, 10), staleCount(10, 10), staleCount(null, 10), staleCount(50, 0)]).toEqual([14, undefined, undefined, undefined])
  expect([staleChip(1), staleChip(14)]).toEqual(['1 commit sem atualizar', '14 commits sem atualizar'])
})

// ---------- roadmap grande: listas curtas, busca e fase ----------

/** Um roadmap inventado e grande (7 fases, 300 itens, 50 decisões), gerado aqui. */
const bigText = () => {
  const phases = Array.from({ length: 7 }, (_, n) => ({
    id: String(n + 1),
    name: `Etapa ${n + 1}`,
    status: n < 2 ? 'done' : n === 2 ? 'doing' : 'todo',
  }))
  const owners = ['Claude', 'Ana', 'both']
  const items = Array.from({ length: 300 }, (_, n) => ({
    id: `item-${n}`,
    phase: String((n % 7) + 1),
    title: `Tarefa ${n} com um título comprido o bastante para não caber inteiro na faixa acima do prompt`,
    status: n % 7 < 2 ? 'done' : n % 5 === 0 ? 'blocked' : n % 4 === 0 ? 'done' : 'todo',
    owner: owners[n % 3],
    ...(n % 5 === 0 ? { waitingOn: 'uma aprovação' } : {}),
    ...(n % 4 === 0 ? { doneAt: `2026-09-${String((n % 28) + 1).padStart(2, '0')}` } : {}),
    ...(n === 153 ? { title: 'Configuração do servidor de e-mail', notes: 'usar o provedor que já temos' } : {}),
  }))
  const openDecisions = Array.from({ length: 50 }, (_, n) => ({ title: `Decisão ${n}`, ...(n % 10 === 0 ? {} : { phase: String((n % 7) + 1) }) }))

  return JSON.stringify({ version: 1, project: 'Grande', owner: 'Ana', phases, items, openDecisions }, null, 2)
}

test('roadmap grande: o roadmap_status corta as listas, e query e phase acham o resto', () => {
  const r = roadmap(bigText())
  const s = summarize(r)
  expect(s.current?.phase.id).toBe('3')
  const text = reportText(r, 'docs/roadmap.json')
  // Uns poucos milhares de caracteres, não dezenas de milhares.
  expect(text.length).toBeLessThan(8000)
  expect(text).toContain(`Com o usuário (Ana), livres agora (${s.mineNow.length}):`)
  expect(text).toContain(`- … e mais ${s.mineNow.length - 8}`)
  expect(text).toContain(`Com o usuário (Ana), em outras fases: ${s.mineElsewhere}.`)
  expect(text).toContain(`Bloqueados em outras fases: ${s.waitingElsewhere}.`)
  expect(text).toContain(`Decisões em aberto de outras fases: ${s.decisionsElsewhere}.`)
  expect(text).toContain('chame roadmap_status com query')

  // Um item livre do Claude, de outra fase e fora das 5 próximas: o resumo não traz o id; a busca, sim.
  const hidden = r.items.filter(i => i.owner === 'Claude' && i.status === 'todo' && i.phase !== '3')[5]!
  expect(s.next.includes(hidden)).toBe(false)
  expect(text).not.toContain(`[${hidden.id}]`)
  expect(reportText(r, 'docs/roadmap.json', undefined, { query: hidden.id })).toMatch(new RegExp(`^Itens do roadmap com "${hidden.id}": \\d+.*\\n- \\[${hidden.id}\\] `))
  // Por palavras do título, sem acento e em qualquer caixa; as notas aparecem.
  const found = reportText(r, 'docs/roadmap.json', undefined, { query: 'configuracao SERVIDOR' })
  expect(found).toBe(
    'Itens do roadmap com "configuracao SERVIDOR": 1.\n- [item-153] Configuração do servidor de e-mail (Claude; a fazer; fase 7; notas: usar o provedor que já temos)',
  )
  expect(searchItems(r, 'tarefa').items).toHaveLength(10)
  expect(reportText(r, 'x', undefined, { query: 'zzz' })).toMatch(/^Nenhum item do roadmap tem "zzz"/)

  // A fase inteira: os não feitos todos, os feitos só com all.
  const phase = reportText(r, 'x', undefined, { phase: '4' })
  const notDone = r.items.filter(i => i.phase === '4' && i.status !== 'done')
  expect(phase).toContain(`Não feitos (${notDone.length}):`)
  expect(notDone.every(i => phase.includes(`[${i.id}]`))).toBe(true)
  expect(phase).toMatch(/Feitos: \d+ \(com all: true, a lista\)\./)
  expect(reportText(r, 'x', undefined, { phase: '4', all: true })).toMatch(/Feitos \(\d+\):\n- \[item-\d+\]/)
  expect(reportText(r, 'x', undefined, { phase: 9 })).toBe('A fase "9" não existe. Fases: 1, 2, 3, 4, 5, 6, 7.')
  // all: tudo, de todas as fases.
  const all = reportText(r, 'x', undefined, { all: true })
  expect(all).toContain(`Com o usuário (Ana) (${r.items.filter(i => i.status !== 'done' && i.owner !== 'Claude').length}):`)
  expect(all).not.toContain('e mais')
})

// ---------- o mod rodando ----------

const FILE = '/proj/docs/roadmap.json'

/** O engine no Windows troca /proj por C:\proj antes de chamar os hooks de fs. */
const k = (p: string) => p.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

type Git = { root?: string; last?: string; count?: number; dirty?: boolean; missing?: boolean }

/**
 * Um projeto de mentira por baixo do plugin, com git simulado. Ler e gravar levam um
 * tique, como no engine (que faz isso fora do módulo), para que duas chamadas se cruzem.
 */
const project = (on: On, files: Record<string, string>, git: Git = { last: 'abc123', count: 2 }) => {
  const clock = mock.clock(on, { now: Date.parse('2026-10-12T12:00:00Z') })
  const mtimes: Record<string, number> = {}
  const seen = {
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
    prompts: [] as string[],
    opened: [] as string[],
    tools: [] as string[],
    writes: 0,
    /** Roda depois de cada leitura (para simular um editor gravando por fora). */
    afterRead: undefined as ((path: string) => void) | undefined,
  }
  const touch = (path: string, text: string) => {
    files[k(path)] = text
    mtimes[k(path)] = (mtimes[k(path)] ?? 0) + 1
  }
  const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ($, e) => {
    if (git.missing) return { deny: 'git não encontrado' }
    const [cmd, sub] = e.argv
    if (cmd !== 'git') return ran('', 1)
    if (sub === 'rev-parse') return ran(`${git.root ?? '/proj'}\n`)
    if (sub === 'log') return ran(git.last ? `${git.last}\n` : '')
    if (sub === 'rev-list') return ran(`${git.count ?? 0}\n`)
    if (sub === 'diff') return ran('', git.dirty ? 1 : 0)
    return ran('', 1)
  })
  on('fs.exists', ($, e) => ({ value: k(e.path) in files }))
  on('fs.read', async ($, e) => {
    await Promise.resolve()
    if (!(k(e.path) in files)) return { deny: 'ENOENT' }
    const text = files[k(e.path)]!
    seen.afterRead?.(e.path)
    return { value: text }
  })
  on('fs.write', async ($, e) => {
    await Promise.resolve()
    seen.writes++
    touch(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    k(e.path) in files
      ? { value: { kind: 'file' as const, size: files[k(e.path)]!.length, mtimeMs: mtimes[k(e.path)] ?? 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => (seen.tools.push(e.name), { value: { tool: `mcp__roadmap__${e.name}` } }))
  on('ui.toast', ($, e) => (seen.toasts.push(e.text), { value: undefined }))
  on('ui.status', ($, e) => (seen.statuses.push(e.text), { value: undefined }))
  on('ui.open', ($, e) => (seen.opened.push(e.id), { value: { isPlaced: true as const } }))
  on('prompt.fill', ($, e) => (seen.prompts.push(e.text), { isFilled: true, text: e.text, cursor: e.text.length }))
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as unknown as RenderElement)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

  return Object.assign(seen, { clock, touch, git })
}

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const PANE_PROPS = { title: 'Roadmap', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} }
const START = { cwd: '/proj', surface: 'terminal' as const, isInteractive: true }
const RUN = { command: 'roadmap', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const bandAt = (bodyColumns: number) => ({ ...BAND, bodyColumns })
const paneAt = (bodyColumns: number) => ({ ...PANE_PROPS, bodyColumns })
/** A linha da faixa com o TEXT: o %, a próxima com o dono e quantos itens do quadro estão com o usuário (o "Comigo" do painel). */
const BAND_LINE = '16%  › Login por e-mail (Claude)  comigo: 3'

type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n

/** O texto que a pessoa lê numa árvore: os textos e os rótulos dos botões. */
const shown = (node: unknown): string => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!isEl(node)) return ''
  const kids = (node.children ?? []).map(shown).join('')
  if (node.type === 'Button' && !kids && typeof node.props?.label === 'string') return node.props.label

  return kids
}

/**
 * Quantas células a linha da faixa ocupa no terminal: cada texto, cada botão
 * ("[ Fazer ]" com moldura, só o rótulo nos sem moldura) e um espaço entre eles.
 */
const rowCells = (row: El) => {
  const kids = (row.children ?? []).filter(isEl)
  const cells = kids.map(k => {
    const text = Array.from(shown(k)).length
    return k.type === 'Button' && !k.props?.plain ? text + 4 : text
  })

  return cells.reduce((a, b) => a + b, 0) + Math.max(0, kids.length - 1) * Number(row.props?.columnGap ?? 0)
}

/** A linha da faixa: o primeiro filho do que o mod devolve (o resto é o que vem de baixo). */
const bandRow = async (band: { drawn: () => Promise<RenderElement> }) => {
  const tree = (await band.drawn()) as unknown as El
  return (tree.children ?? []).find(isEl)!
}

/** As chaves de um elemento e de tudo dentro dele. */
const keysIn = (n: unknown): string[] => (isEl(n) ? [String(n.props?.key ?? ''), ...(n.children ?? []).flatMap(keysIn)] : [])

/** As chaves dos cartões, na ordem do quadro. */
const cardKeys = async (ui: { findAll: (q: { type?: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('card-'))

test('ferramentas: status, update e add gravam o roadmap e avisam na tela', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  expect(seen.tools).toEqual(['roadmap_status', 'roadmap_update', 'roadmap_add'])
  expect(seen.statuses.at(-1)).toBe('Fase 2 · 16%')

  const status = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)
  expect(status).toContain('Roadmap de Farol (até o beta), atualizado em 2026-10-01. Arquivo: docs/roadmap.json')
  expect(status).toContain('Fase atual: Fase 2 Beta fechado (em andamento), 16% (1 de 6 itens). Gate: dez pessoas usam por uma semana (pendente).')
  expect(status).toContain('Próximas:\n- [login] Login por e-mail (Claude; em andamento; fase 2)\n- [modo-escuro] Modo escuro')
  expect(status).toContain('Com o usuário (Ana), livres agora (1):\n- [icone] Aprovar o ícone (você; a fazer; fase 2)')
  expect(status).toContain(
    'Com o usuário (Ana), depois (bloqueados ou esperando uma dependência) (2):\n- [convidar-testadores] Convidar os testadores (você; a fazer; fase 2; depende de: login)',
  )
  expect(status).toContain('Com o usuário (Ana), em outras fases: 1.')
  expect(status).toContain('Esperando, na fase atual (1):\n- [conta-loja] Conta de desenvolvedor na loja (você e Claude; bloqueado; fase 2; espera: aprovação do cartão)')
  expect(status).toContain('Decisões em aberto de outras fases: 1.')
  expect(status).not.toContain('desatualizado')
  // Com query, o id de um item que não está no resumo; com phase, a fase.
  const search = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status', query: 'página' } as never)).result)
  expect(search).toBe('Itens do roadmap com "página": 1.\n- [pagina] Página do produto (Claude; a fazer; fase 3)')
  const phase = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status', phase: '3' } as never)).result)
  expect(phase).toContain('Fase 3 Lançamento (a fazer), 0% (0 de 2 itens).\nNão feitos (2):\n- [publicar] Publicar na loja (você e Claude; a fazer; fase 3; gate; depende de: conta-loja)')
  expect(phase).toContain('Decisões em aberto (1):\n- Cobrar assinatura? (fase 3) · docs/precos.md')

  const done = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'login', status: 'done', evidence: 'commit def456' } as never)
  expect(done.result).toBe('"Login por e-mail" → feito em 2026-10-12')
  expect(seen.toasts.at(-1)).toBe('Claude atualizou o roadmap: "Login por e-mail" → feito em 2026-10-12')
  expect(seen.statuses.at(-1)).toBe('Fase 2 · 33%')
  expect(roadmap(files[FILE]).items.find(i => i.id === 'login')).toMatchObject({ status: 'done', doneAt: TODAY, evidence: 'commit def456' })

  const written = files[FILE]
  const unknown = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'logon', status: 'done' } as never)
  expect(unknown.deny).toContain('Não existe item "logon" no roadmap.')
  const invalid = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'icone', status: 'feito' } as never)
  expect(invalid.deny).toBe('Status "feito" inválido: use done, doing, todo ou blocked.')
  expect(files[FILE]).toBe(written)

  const added = await $.tool.call({ tool: 'mcp__roadmap__roadmap_add', phase: '2', title: 'Tela de configurações', owner: 'Claude', after: 'login' } as never)
  expect(added.result).toBe('Item criado na Fase 2 Beta fechado: "Tela de configurações" (tela-de-configuracoes)')
  expect(seen.toasts.at(-1)).toBe('Claude criou no roadmap: Item criado na Fase 2 Beta fechado: "Tela de configurações" (tela-de-configuracoes)')
  expect(roadmap(files[FILE]).path).toEqual(['login', 'tela-de-configuracoes', 'modo-escuro', 'icone'])
})

test('faixa: uma linha com a fase, a barrinha, o %, a próxima e os botões; Fazer, Roadmap e Ocultar', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: 'Fase 2' }), surface).toBeDefined()
    expect((await band.find({ type: 'Text', text: /^16% / }))?.text).toBe(BAND_LINE)
    // A barrinha: glifos no terminal, SVG no desktop.
    expect(await band.find({ type: 'Text', text: '▰▰▱▱▱▱▱▱▱▱' }), surface).toEqual(surface === 'terminal' ? expect.anything() : undefined)
    expect((await band.find({ type: 'Svg' }))?.props.alt, surface).toBe(surface === 'terminal' ? undefined : '16% da fase feito')
    expect((await band.find({ key: 'roadmap-go' }))?.props).toMatchObject({ label: 'Fazer', variant: 'primary' })
    expect((await band.find({ key: 'roadmap-view' }))?.props.label).toBe('Roadmap')
    expect((await band.find({ key: 'roadmap-hide' }))?.props).toMatchObject({ label: surface === 'terminal' ? 'ocultar' : 'Ocultar', plain: true, dimColor: true, role: 'dismiss' })
    // Nada de texto corrido: a linha toda é menor que a largura.
    expect(rowCells(await bandRow(band))).toBeLessThanOrEqual(BAND.bodyColumns)
    await band.press({ key: 'roadmap-go' })
    expect(seen.prompts.at(-1)).toBe(
      'Continue a tarefa "Login por e-mail" (login) do roadmap, que já está em andamento. Ao terminar, marque como feita no roadmap (roadmap_update), com a evidência do que foi feito.',
    )
    await band.press({ key: 'roadmap-view' })
    expect(seen.opened.at(-1)).toBe('roadmap')
    await band.unmount()
  }

  // Mais estreita: para o rótulo caber inteiro, saem o "comigo", o dono, a barrinha, a moldura
  // dos botões ("Roadmap" vira "Ver") e o "Fase N", nesta ordem; sempre numa linha.
  const steps = [
    { width: 100, mine: true, owner: true, bar: true, framed: true, head: true },
    { width: 85, mine: false, owner: true, bar: true, framed: true, head: true },
    { width: 75, mine: false, owner: false, bar: true, framed: true, head: true },
    { width: 70, mine: false, owner: false, bar: false, framed: true, head: true },
    { width: 50, mine: false, owner: false, bar: false, framed: false, head: true },
    { width: 45, mine: false, owner: false, bar: false, framed: false, head: false },
  ]
  const some = (on: boolean) => (on ? expect.anything() : undefined)
  for (const { width, mine, owner, bar, framed, head } of steps) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: bandAt(width) })
    const at = `largura ${width}`
    expect(rowCells(await bandRow(band)), at).toBeLessThanOrEqual(width)
    const line = (await band.find({ type: 'Text', text: /^16% / }))?.text ?? ''
    expect(line, at).toContain('› Login por e-mail')
    expect(line.includes('comigo: 3'), at).toBe(mine)
    expect(line.includes('(Claude)'), at).toBe(owner)
    expect(await band.find({ type: 'Text', text: /▰/ }), at).toEqual(some(bar))
    expect((await band.find({ key: 'roadmap-view' }))?.props, at).toMatchObject(framed ? { label: 'Roadmap' } : { label: 'Ver', plain: true })
    expect(await band.find({ type: 'Text', text: 'Fase 2' }), at).toEqual(some(head))
    await band.unmount()
  }
  // Só quando nem assim cabe, o rótulo encolhe.
  const tiny = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: bandAt(36) })
  expect((await tiny.find({ type: 'Text', text: /^16% / }))?.text).toBe('16%  › Login por…')
  expect(rowCells(await bandRow(tiny))).toBeLessThanOrEqual(36)
  await tiny.unmount()

  // Ocultar: some até o roadmap mudar.
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'roadmap-hide' })
  expect(await band.find({ text: /Fase 2/ })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'login', status: 'done' } as never)
  // Com o login feito, convidar os testadores sai do Esperando e vai para as Próximas: ainda 3 com você.
  expect((await band.find({ type: 'Text', text: /^33% / }))?.text).toBe('33%  › Modo escuro (Claude)  comigo: 3')
})

test('painel: trilha, cartão da fase, filtro e quadro, sem listas de texto', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: 'Farol' }), surface).toBeDefined()
    // A trilha e a barra da fase: glifos no terminal; no desktop, dois SVGs com texto alternativo.
    const svgs = (await pane.findAll({ type: 'Svg' })).map(s => s.props.alt)
    if (surface === 'terminal') {
      expect(svgs).toEqual([])
      const trail = await pane.find({ key: 'trail' })
      expect(trail?.text).toContain('◉ 16% ━')
      expect(trail?.text).toContain('2 Beta fechado')
      // A barra: feito e em andamento cheios, esperando em ▒, o resto vazio.
      expect(await pane.find({ type: 'Text', text: `${'█'.repeat(14)}${'▒'.repeat(6)}${'░'.repeat(20)}` })).toBeDefined()
    } else {
      expect(svgs).toEqual(['Fases: 1 Protótipo feita; 2 Beta fechado atual, 16%; 3 Lançamento a fazer', '1 de 6 feitos · 1 em andamento · 1 esperando'])
    }
    // O cartão da fase atual: título curto, gate, barra segmentada, % e contagens.
    for (const text of ['Fase 2 · Beta fechado', '⚑ Gate 2 · pendente', '16%', '1 ✓  1 ▶  1 ‖  3 ○']) {
      expect(await pane.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    // O filtro.
    expect((await pane.find({ key: 'filter-all' }))?.props).toMatchObject({ label: 'Tudo', variant: 'primary' })
    expect((await pane.find({ key: 'filter-mine' }))?.props).toMatchObject({ label: 'Comigo 3', dimColor: true })
    // O quadro: 4 colunas, cada uma com o contador, e um cartão por item.
    for (const text of ['Agora 1', 'Próximas 3', 'Esperando 2', 'Feito 1']) {
      expect(await pane.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    expect(await cardKeys(pane)).toEqual(['card-login', 'card-modo-escuro', 'card-icone', 'card-pagina', 'card-conta-loja', 'card-convidar-testadores', 'card-sincronizar-notas'])
    expect((await pane.find({ key: 'card-login' }))?.props).toMatchObject({ label: 'Login por e-mail', plain: true })
    expect((await pane.find({ key: 'box-login' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude' })
    expect((await pane.find({ key: 'box-login' }))?.text).toBe('Login por e-mailClaude')
    expect((await pane.find({ key: 'box-icone' }))?.text).toBe('Aprovar o ícone' + 'você')
    // Outra fase: a fase no cartão; esperando: borda tracejada e o que espera (‖ bloqueado, "depois de" a
    // tarefa que falta); feito: apagado.
    expect((await pane.find({ key: 'box-pagina' }))?.text).toBe('Página do produtoClaude  Fase 3')
    for (const key of ['box-conta-loja', 'box-convidar-testadores']) expect((await pane.find({ key }))?.props.borderStyle).toBe('dashed')
    // Em duas linhas da coluna (20 células), cortado de preferência no fim de uma palavra.
    expect((await pane.find({ key: 'box-conta-loja' }))?.text).toBe('Conta de desenvolvedor na…‖ aprovação do cartão')
    expect((await pane.find({ key: 'box-convidar-testadores' }))?.text).toBe('Convidar os testadoresdepois de Login por e-mail')
    expect((await pane.find({ key: 'card-sincronizar-notas' }))?.props.dimColor).toBe(true)
    expect((await pane.find({ key: 'box-sincronizar-notas' }))?.text).toBe('Sincronizar notas')
    // O que espera em outra fase (publicar) e a decisão de outra fase ficam fora.
    expect(await pane.find({ text: /Publicar na loja|Cobrar assinatura/ })).toBeUndefined()
    // Sem decisões da fase atual e sem aviso: nada de rodapé. Sem detalhe antes de escolher um cartão.
    for (const key of ['decisions', 'footer', 'detail']) expect(await pane.find({ key }), `${surface}: ${key}`).toBeUndefined()
    expect(await pane.findAll({ type: 'Markdown' })).toEqual([])
    await pane.unmount()
  }
})

test('painel: escolher um cartão abre o detalhe; Fazer agora põe o pedido no prompt; Fechar fecha', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })

  await pane.press({ key: 'card-icone' })
  expect((await pane.find({ key: 'box-icone' }))?.props).toMatchObject({ borderStyle: 'bold', borderColor: 'claude' })
  // Aberto no lugar: o estado primeiro (sem "Fase 2", que é a atual) e sem repetir o título, igual ao rótulo.
  expect(await pane.find({ type: 'Text', text: 'Aprovar o ícone' })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: '○ a fazer  você' })).toBeDefined()
  expect(keysIn(await pane.find({ key: 'box-icone' }))).toContain('detail')
  expect((await pane.find({ key: 'detail-start' }))?.props).toMatchObject({ label: 'Fazer agora', variant: 'primary' })
  await pane.press({ key: 'detail-start' })
  expect(seen.prompts.at(-1)).toMatch(/^Me ajude com a tarefa "Aprovar o ícone" \(icone\) do roadmap, que é minha: diga o que eu preciso fazer/)
  await pane.press({ key: 'detail-close' })
  expect(await pane.find({ key: 'detail' })).toBeUndefined()
  expect((await pane.find({ key: 'box-icone' }))?.props.borderStyle).toBe('round')

  // O bloqueado: o que ele espera, e "Ver o que falta" no lugar de "Fazer agora"; clicar de novo no mesmo cartão fecha.
  await pane.press({ key: 'card-conta-loja' })
  expect(await pane.find({ type: 'Text', text: '‖ bloqueado  os dois' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'espera: aprovação do cartão' })).toBeDefined()
  expect((await pane.find({ key: 'detail-start' }))?.props.label).toBe('Ver o que falta')
  await pane.press({ key: 'detail-start' })
  expect(seen.prompts.at(-1)).toMatch(/^A tarefa "Conta de desenvolvedor na loja" \(conta-loja\) do roadmap está bloqueada, esperando aprovação do cartão\. /)
  await pane.press({ key: 'card-conta-loja' })
  expect(await pane.find({ key: 'detail' })).toBeUndefined()
  // O que espera outra tarefa: "depois de" e também "Ver o que falta".
  await pane.press({ key: 'card-convidar-testadores' })
  expect(await pane.find({ type: 'Text', text: 'depois de: Login por e-mail' })).toBeDefined()
  expect((await pane.find({ key: 'detail-start' }))?.props.label).toBe('Ver o que falta')

  // O feito: data, sem "Fazer agora".
  await pane.press({ key: 'card-sincronizar-notas' })
  expect(await pane.find({ type: 'Text', text: 'feito em 2026-10-02' })).toBeDefined()
  expect(await pane.find({ key: 'detail-start' })).toBeUndefined()
  // Outro cartão troca o detalhe; o da próxima fase leva a fase e o gate.
  await pane.press({ key: 'card-pagina' })
  expect(await pane.find({ type: 'Text', text: '○ a fazer  Claude  Fase 3' })).toBeDefined()
  await pane.press({ key: 'detail-start' })
  expect(seen.prompts.at(-1)).toBe(
    'Faça a tarefa "Página do produto" (pagina) do roadmap: marque como em andamento no roadmap (roadmap_update) ao começar e, ao terminar, como feita, com a evidência do que foi feito.',
  )
  await pane.unmount()

  // Com "short", o cartão aberto traz só o que o título acrescenta ao rótulo.
  seen.touch(FILE, TEXT.replace('"title": "Login por e-mail",', '"title": "Login por e-mail: com link mágico e confirmação",\n      "short": "Login por e-mail",'))
  await seen.clock.advance(15_000)
  const again = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  await again.press({ key: 'card-login' })
  expect((await again.find({ key: 'card-login' }))?.props.label).toBe('Login por e-mail')
  expect(await again.find({ type: 'Text', text: 'com link mágico e confirmação' })).toBeDefined()
})

test('painel: o filtro Comigo e a coluna que abre no +N', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })

  await pane.press({ key: 'filter-mine' })
  expect((await pane.find({ key: 'filter-mine' }))?.props.variant).toBe('primary')
  expect((await pane.find({ key: 'filter-all' }))?.props.dimColor).toBe(true)
  expect(await cardKeys(pane)).toEqual(['card-icone', 'card-conta-loja', 'card-convidar-testadores'])
  for (const text of ['Agora 0', 'Próximas 1', 'Esperando 2', 'Feito 0']) expect(await pane.find({ type: 'Text', text }), text).toBeDefined()
  expect((await pane.findAll({ type: 'Text', text: '—' })).length).toBe(2)
  await pane.press({ key: 'filter-all' })
  expect((await cardKeys(pane)).length).toBe(7)
  await pane.unmount()

  // Um roadmap grande: cada coluna mostra 4 (Feito, 3); cada "+N" abre mais 8 e "menos" volta.
  seen.touch(FILE, bigText())
  await seen.clock.advance(15_000)
  const r = roadmap(files[FILE])
  const kb = kanban(r, { width: PANE_PROPS.bodyColumns })
  const next = kb.columns[1]!
  const big = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  const inNext = async () => ((await big.find({ key: 'col-next' }))?.children ?? []).flatMap(keysIn).filter(k => k.startsWith('card-')).length
  const moreLabel = (n: number) => (n > 8 ? `+8 de ${n}` : `+${n}`)
  expect(await inNext()).toBe(4)
  expect((await big.find({ key: 'more-next' }))?.props.label).toBe(moreLabel(next.total - 4))
  expect((await big.find({ key: 'more-done' }))?.props.label).toBe(moreLabel(kb.columns[3]!.total - 3))
  expect(await big.find({ key: 'less-next' })).toBeUndefined()
  await big.press({ key: 'more-next' })
  expect(await inNext()).toBe(12)
  expect((await big.find({ key: 'more-next' }))?.props.label).toBe(moreLabel(next.total - 12))
  expect((await big.find({ key: 'less-next' }))?.props.label).toBe('menos')
  await big.press({ key: 'more-next' })
  expect(await inNext()).toBe(20)
  await big.press({ key: 'less-next' })
  expect(await inNext()).toBe(4)
  expect(await big.find({ key: 'less-next' })).toBeUndefined()
  // Sem "short", o cartão mostra o título cortado em 40, em até duas linhas da coluna.
  const first = r.items.find(i => i.id === next.cards[0]!.id)!
  expect(first.short).toBeUndefined()
  expect((await big.find({ key: `card-${first.id}` }))?.props.label).toBe(cardLabel(itemLabel(first), kb.columnWidth - 4))
  // Aberto, o cartão sem "short" troca o rótulo pelo título inteiro, em até 4 linhas, e não o repete embaixo.
  await big.press({ key: `card-${first.id}` })
  const whole = cardLabel(first.title, kb.columnWidth - 4, 4)
  expect(Array.from(whole).length).toBeGreaterThan(40)
  expect((await big.find({ key: `card-${first.id}` }))?.props.label).toBe(whole)
  expect(await big.find({ type: 'Text', text: first.title })).toBeUndefined()
  await big.press({ key: `card-${first.id}` })
  // O cartão escolhido que sai de vista (a coluna fechou) abre numa caixa acima do quadro, com o título inteiro.
  await big.press({ key: 'more-next' })
  const tenth = kanban(r, { width: PANE_PROPS.bodyColumns, expanded: { next: 1 } }).columns[1]!.cards[9]!
  await big.press({ key: `card-${tenth.id}` })
  expect(keysIn(await big.find({ key: `box-${tenth.id}` }))).toContain('detail')
  await big.press({ key: 'less-next' })
  expect((await big.find({ key: 'detail' }))?.props).toMatchObject({ borderStyle: 'round', borderColor: 'claude' })
  expect(await big.find({ type: 'Text', text: r.items.find(i => i.id === tenth.id)!.title })).toBeDefined()
  await big.press({ key: 'detail-close' })
  expect(await big.find({ key: 'detail' })).toBeUndefined()
})

test('painel: no Feito, o que acabou de ser feito vem primeiro, mesmo no meio do arquivo', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'modo-escuro', status: 'done' } as never)
  await seen.clock.advance(1000)
  // No arquivo, o ícone vem antes do modo escuro; os dois feitos hoje, mas o ícone depois.
  await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'icone', status: 'done' } as never)
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: paneAt(120) })
  const done = ((await pane.find({ key: 'col-done' }))?.children ?? []).flatMap(keysIn).filter(k => k.startsWith('card-'))
  expect(done).toEqual(['card-icone', 'card-modo-escuro', 'card-sincronizar-notas'])
})

test('painel: 4 colunas a partir de 96, grade 2x2 de 60 a 95, empilhado abaixo de 60', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const layouts = [
    { width: 120, direction: 'row', column: 29, rows: 0 },
    { width: 70, direction: 'column', column: 34, rows: 2 },
    { width: 40, direction: 'column', column: 40, rows: 0 },
  ]
  for (const { width, direction, column, rows } of layouts) {
    const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: paneAt(width) })
    const board = await pane.find({ key: 'board' })
    expect(board?.props.flexDirection, `largura ${width}`).toBe(direction)
    // Na grade, duas linhas de duas colunas; nas outras, as colunas direto no quadro.
    expect(board?.children.filter(c => isEl(c) && c.type === 'Box' && c.props?.flexDirection === 'row').length, `largura ${width}`).toBe(rows)
    const cols = (await pane.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('col-'))
    expect(cols.map(c => c.key)).toEqual(width < 60 ? ['col-doing', 'col-next', 'col-waiting'] : ['col-doing', 'col-next', 'col-waiting', 'col-done'])
    expect(cols.every(c => c.props.width === column), `largura ${width}`).toBe(true)
    // Empilhado, o Feito vira uma linha só, com a contagem.
    expect(await pane.find({ type: 'Text', text: '✓ Feito 1' }), `largura ${width}`).toEqual(width < 60 ? expect.anything() : undefined)
    // A trilha de glifos cabe na largura.
    const trail = await pane.find({ key: 'trail' })
    const lines = (trail?.children ?? []).filter(isEl).map(shown)
    expect(lines.length).toBe(2)
    for (const line of lines) expect(Array.from(line).length, `largura ${width}: ${line}`).toBeLessThanOrEqual(width)
    await pane.unmount()
  }
})

test('nas 4 superfícies a árvore é válida; SVG fora do terminal, glifos nele', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT.replace('"phase": "3",\n      "ref"', '"ref"') }
  const seen = project(on, files, { last: 'abc123', count: 14 })
  await $.session.start(START)
  await seen.clock.settle()

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    // Tudo aberto: o detalhe de um cartão e a lista de decisões.
    if (!(await pane.find({ key: 'detail' }))) await pane.press({ key: 'card-conta-loja' })
    if (!(await pane.find({ type: 'Text', text: '• Cobrar assinatura?' }))) await pane.press({ key: 'decisions' })
    // drawn() rejeita quando a superfície não aceita a árvore.
    expect(await pane.drawn(), surface).toMatchObject({ type: 'Box' })
    expect(await pane.find({ key: 'detail' }), surface).toBeDefined()
    expect(await pane.find({ type: 'Text', text: '• Cobrar assinatura?' }), surface).toBeDefined()
    // Fora do terminal, a trilha e a barra da fase em SVG; no terminal, a trilha em glifos.
    const alts = (await pane.findAll({ type: 'Svg' })).map(s => String(s.props.alt).slice(0, 7))
    expect(alts, surface).toEqual(surface === 'terminal' ? [] : ['Fases: ', '1 de 6 '])
    expect((await pane.find({ key: 'trail' }))?.type, surface).toBe(surface === 'terminal' ? 'Box' : undefined)
    await pane.unmount()
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.drawn(), surface).toMatchObject({ type: 'Box' })
    expect((await band.findAll({ type: 'Svg' })).map(s => s.props.alt), surface).toEqual(surface === 'terminal' ? [] : ['16% da fase feito'])
    await band.unmount()
  }
})

test('roadmap grande (300 itens): o painel fica curto e a faixa corta o rótulo', async ($, on) => {
  const files: Record<string, string> = { [FILE]: bigText() }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const r = roadmap(files[FILE])
  const s = summarize(r)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    const line = (await band.find({ type: 'Text', text: new RegExp(`^${s.current?.pct}% `) }))?.text ?? ''
    expect(line.startsWith(`${s.current?.pct}%  › ${itemLabel(s.next[0]!).slice(0, 20)}`)).toBe(true)
    expect(line).toContain('…')
    if (surface === 'terminal') expect(rowCells(await bandRow(band))).toBeLessThanOrEqual(BAND.bodyColumns)
    await band.unmount()

    // Antes (0.1.0), com estes mesmos 300 itens: 5342 caracteres de texto no terminal e 5258 no desktop,
    // em 133 textos. Agora (0.2.0): 825 e 607, em 63 e 35 textos; só os cartões que cabem nas colunas.
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    const text = shown(await pane.drawn())
    const texts = (await pane.findAll({ type: 'Text' })).length
    expect([text.length, texts], surface).toEqual(surface === 'terminal' ? [825, 63] : [607, 35])
    // Nada em andamento nesta fase: 0 + 4 + 4 + 3 cartões.
    expect((await cardKeys(pane)).length).toBe(11)
    for (const [key, header] of [
      ['more-next', 'Próximas'],
      ['more-waiting', 'Esperando'],
    ] as const) {
      const col = kanban(r, { width: PANE_PROPS.bodyColumns }).columns.find(c => c.title === header)!
      const left = col.total - 4
      expect((await pane.find({ key }))?.props.label).toBe(left > 8 ? `+8 de ${left}` : `+${left}`)
    }
    await pane.unmount()
  }
})

test('rodapé: as decisões da fase atual num chip que abre uma lista curta', async ($, on) => {
  const decisions = Array.from({ length: 7 }, (_, n) => ({ title: n === 0 ? `Decidir ${'o preço da assinatura '.repeat(5)}` : `Decisão ${n}` }))
  const doc = JSON.parse(TEXT) as Record<string, unknown>
  const files: Record<string, string> = { [FILE]: JSON.stringify({ ...doc, openDecisions: decisions }, null, 2) }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  expect((await pane.find({ key: 'decisions' }))?.props.label).toBe('Decisões 7')
  expect(await pane.find({ type: 'Text', text: /^• / })).toBeUndefined()
  await pane.press({ key: 'decisions' })
  const lines = (await pane.findAll({ type: 'Text', text: /^• / })).map(t => t.text)
  expect(lines).toEqual([`• ${cut(decisions[0]!.title, 70)}`, '• Decisão 1', '• Decisão 2', '• Decisão 3', '• Decisão 4'])
  await pane.press({ key: 'decisions' })
  expect(await pane.find({ type: 'Text', text: /^• / })).toBeUndefined()
})

test('duas gravações ao mesmo tempo não se apagam, e uma mudança por fora no meio é refeita', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()

  // Dois subagentes marcando ao mesmo tempo: as duas marcações ficam.
  const both = await Promise.all([
    $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'modo-escuro', status: 'done' } as never),
    $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'icone', status: 'done' } as never),
    $.tool.call({ tool: 'mcp__roadmap__roadmap_add', phase: '3', title: 'Lista de espera' } as never),
  ])
  expect(both.map(r => r.result)).toEqual([
    '"Modo escuro" → feito em 2026-10-12',
    '"Aprovar o ícone" → feito em 2026-10-12',
    'Item criado na Fase 3 Lançamento: "Lista de espera" (lista-de-espera)',
  ])
  const after = roadmap(files[FILE])
  expect(after.items.filter(i => ['modo-escuro', 'icone'].includes(i.id)).map(i => i.status)).toEqual(['done', 'done'])
  expect(after.items.some(i => i.id === 'lista-de-espera')).toBe(true)
  expect(seen.writes).toBe(3)

  // Um editor grava logo depois de o mod ler: o mod lê de novo e aplica sobre o texto novo.
  let sneak = true
  seen.afterRead = path => {
    if (!sneak) return
    sneak = false
    seen.touch(path, files[k(path)]!.replace('"title": "Página do produto"', '"title": "Página do produto nova"'))
  }
  const ran = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'login', status: 'done' } as never)
  expect(ran.result).toBe('"Login por e-mail" → feito em 2026-10-12')
  const merged = roadmap(files[FILE])
  expect(merged.items.find(i => i.id === 'login')?.status).toBe('done')
  expect(merged.items.find(i => i.id === 'pagina')?.title).toBe('Página do produto nova')

  // Se ele não para de mexer, o mod desiste sem gravar e diz por quê.
  const before = seen.writes
  seen.afterRead = path => seen.touch(path, `${files[k(path)]!.trimEnd()}\n`)
  const stuck = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'pagina', status: 'doing' } as never)
  expect(stuck.deny).toMatch(/^O roadmap mudou por fora enquanto eu gravava/)
  expect(seen.writes).toBe(before)
})

test('depois de um git commit, o Claude é lembrado do roadmap', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { last: 'abc123', count: 3 })
  await $.session.start(START)
  await seen.clock.settle()
  const bash = (command: string) => $.tool.call({ tool: 'Bash', command } as never)
  const note =
    'Este projeto tem roadmap (docs/roadmap.json). Se este commit terminou um item, marque com roadmap_update e a evidência (o commit); o roadmap_status com query acha o id.'

  expect((await bash('git add -A && git commit -m "Login por e-mail"')).context).toEqual([note])
  expect((await bash('git -C /proj commit -F msg.txt')).context).toEqual([note])
  // Outros comandos, nada.
  expect((await bash('git log --grep commit')).context).toBeUndefined()
  expect((await bash('ls')).context).toBeUndefined()
  // Desatualizado: o aviso vai junto.
  seen.git.count = 14
  expect((await bash('git commit -m x')).context).toEqual([`${note} Aviso: roadmap desatualizado: 14 commits sem atualizar.`])
  // O commit mexeu no roadmap (nenhum commit depois do último dele): não precisa lembrar.
  seen.git.count = 0
  expect((await bash('git commit -m x')).context).toBeUndefined()
})

test('desatualizado: conta os commits depois do último que mexeu no roadmap; /roadmap resume e abre o painel', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { last: 'abc123', count: 14 })
  await $.session.start(START)
  await seen.clock.settle()
  const chip = '⚠ 14 commits sem atualizar'

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /^16% / }))?.text, surface).toBe(`${BAND_LINE}  ${chip}`)
    expect(rowCells(await bandRow(band))).toBeLessThanOrEqual(BAND.bodyColumns)
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: chip }), surface).toBeDefined()
    await pane.unmount()
  }
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)).toContain('Aviso: roadmap desatualizado: 14 commits sem atualizar.')
  seen.opened.length = 0
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe(`Fase 2 · 16% · próxima: Login por e-mail · ${chip}`)
  expect(seen.opened).toEqual(['roadmap'])

  // No limite (10), não avisa.
  seen.git.count = 10
  expect((await $.command.run(RUN)).text).toBe('Fase 2 · 16% · próxima: Login por e-mail')
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /sem atualizar/ })).toBeUndefined()
  // Roadmap mexido e ainda não commitado: está sendo atualizado, não avisa.
  seen.git.count = 30
  seen.git.dirty = true
  await $.command.run(RUN)
  expect(await band.find({ text: /sem atualizar/ })).toBeUndefined()
  // Arquivo que nunca entrou num commit: sem aviso.
  seen.git.dirty = false
  seen.git.last = undefined
  await $.command.run(RUN)
  expect(await band.find({ text: /sem atualizar/ })).toBeUndefined()
})

test('sem git: o roadmap aparece e não há aviso de desatualizado', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { missing: true, count: 50 })
  await $.session.start(START)
  await seen.clock.settle()
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text', text: /^16% / }))?.text).toBe(BAND_LINE)
  expect(await band.find({ text: /sem atualizar/ })).toBeUndefined()
})

test('sem roadmap no projeto: nada na faixa nem na linha de status; o painel oferece criar', async ($, on) => {
  const files: Record<string, string> = {}
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /Fase|Roadmap/ })).toBeUndefined()
    await band.unmount()
  }
  expect(seen.statuses.every(s => s === undefined)).toBe(true)
  const status = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)
  expect(status).toMatch(/^Não há roadmap neste projeto \(procurei em docs\/roadmap\.json\)\. Para criar um/)
  const update = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'x', status: 'done' } as never)
  expect(update.deny).toMatch(/^Não há roadmap neste projeto/)
  expect(files).toEqual({})
  expect((await $.command.run(RUN)).text).toBe('Sem roadmap em docs/roadmap.json')

  for (const surface of SURFACES) {
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: 'Sem roadmap · docs/roadmap.json' }), surface).toBeDefined()
    expect(await pane.drawn(), surface).toMatchObject({ type: 'Box' })
    await pane.press({ key: 'roadmap-create' })
    expect(seen.prompts.at(-1)).toMatch(/^Crie o roadmap deste projeto em docs\/roadmap\.json, no formato versão 1 .*com um "short" de até 40 caracteres/)
    await pane.unmount()
  }
})

test('arquivo com erro: a faixa e o painel mostram a linha e o motivo, e as ferramentas não gravam', async ($, on) => {
  const broken = TEXT.replace('"status": "blocked"', '"status": "travado"')
  const files: Record<string, string> = { [FILE]: broken }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const reason = `linha ${lineOf(broken, '"travado"')}: item "conta-loja": status "travado" inválido (use done, doing, todo ou blocked)`
  expect(seen.statuses.at(-1)).toBe('Roadmap com erro')
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /^⚠ Roadmap com erro: / }))?.text).toBe(`⚠ Roadmap com erro: ${cut(reason, 80)}`)
    await band.press({ key: 'roadmap-view' })
    expect(seen.opened.at(-1)).toBe('roadmap')
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: '⚠ Roadmap com erro' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: reason })).toBeDefined()
    expect(await pane.find({ key: 'roadmap-reload' })).toBeDefined()
    await pane.unmount()
  }
  expect((await $.command.run(RUN)).text).toBe(`Roadmap com erro: ${reason}`)
  const update = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'login', status: 'done' } as never)
  expect(update.deny).toBe(`O roadmap tem erro e não foi alterado (${reason}). Corrija o arquivo antes.`)
  const add = await $.tool.call({ tool: 'mcp__roadmap__roadmap_add', phase: '2', title: 'X' } as never)
  expect(add.deny).toMatch(/^O roadmap tem erro e não foi alterado/)
  expect(files[FILE]).toBe(broken)
})

test('relê quando o Claude edita o arquivo e quando ele muda por fora', async ($, on) => {
  // Raiz do git como no Windows (C:/proj) e o Claude editando com barras invertidas.
  const files: Record<string, string> = { [FILE]: TEXT.replaceAll('\n', '\r\n') }
  const seen = project(on, files, { root: 'C:/proj', last: 'abc123', count: 2 })
  on('tool.call', { tool: 'Edit' }, ($, e) => {
    seen.touch(e.file_path, files[k(e.file_path)]!.replace(e.old_string, e.new_string))
    return { result: {} } as never
  })
  await $.session.start(START)
  await seen.clock.settle()
  expect(seen.statuses.at(-1)).toBe('Fase 2 · 16%')

  // O Claude edita com Edit, no caminho do Windows: relê na hora.
  await $.tool.call({
    tool: 'Edit',
    file_path: 'C:\\proj\\docs\\roadmap.json',
    old_string: '"title": "Login por e-mail",\r\n      "status": "doing"',
    new_string: '"title": "Login por e-mail",\r\n      "status": "done"',
  } as never)
  expect(seen.statuses.at(-1)).toBe('Fase 2 · 33%')

  // Mudança por fora (outro editor, git pull): aparece na próxima conferência, em até 15 s.
  seen.touch(FILE, files[FILE]!.replace('"status": "todo",\r\n      "owner": "ana"', '"status": "done",\r\n      "owner": "ana"'))
  await seen.clock.advance(15_000)
  expect(seen.statuses.at(-1)).toBe('Fase 2 · 50%')

  // E o que o mod grava mantém o CRLF do arquivo.
  await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'modo-escuro', status: 'doing' } as never)
  expect(/[^\r]\n/.test(files[FILE]!)).toBe(false)
})

test('opções: sem faixa, outro limite de commits e o Claude sem ferramentas de escrita', { options: { showBand: false, staleAfter: 3, claudeCanEdit: false } }, async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { last: 'abc123', count: 5 })
  await $.session.start(START)
  await seen.clock.settle()
  expect(seen.tools).toEqual(['roadmap_status'])
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /Fase|Roadmap/ })).toBeUndefined()
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)).toContain(
    'Aviso: roadmap desatualizado: 5 commits sem atualizar.',
  )
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: '⚠ 5 commits sem atualizar' })).toBeDefined()
  await pane.press({ key: 'card-modo-escuro' })
  await pane.press({ key: 'detail-start' })
  expect(seen.prompts.at(-1)).toBe(
    'Faça a tarefa "Modo escuro" (modo-escuro) do roadmap: marque como em andamento no roadmap ao começar e, ao terminar, como feita, com a evidência do que foi feito.',
  )
  // Sem as ferramentas de escrita, o commit não traz o lembrete.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)).context).toBeUndefined()
})
