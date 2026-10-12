import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import {
  TEMPLATE,
  applyAdd,
  applyUpdate,
  cut,
  formatJson,
  missingText,
  parseRoadmap,
  reportText,
  scanJson,
  searchItems,
  slugify,
  staleText,
  startPrompt,
  statusLine,
  summarize,
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
  // De "both": cada um faz a sua parte, e feita só com as duas prontas.
  const both = roadmap(TEXT.replace('"waitingOn": "aprovação do cartão"', '"notes": "precisa do cartão da empresa"').replace('"status": "blocked"', '"status": "todo"'))
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
const HEADLINE = 'Roadmap · Fase 2 Beta fechado · 16% · Próxima: Login por e-mail (Claude) · 1 com você agora'

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

test('faixa e painel no terminal e no desktop; Fazer a próxima, Ver roadmap, Ocultar e Pedir ao Claude', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect((await band.find({ type: 'Text', text: /^Roadmap · / }))?.text).toBe(HEADLINE)
    expect((await band.find({ type: 'Svg' })) !== undefined).toBe(surface === 'desktop')
    await band.press({ key: 'roadmap-go' })
    expect(seen.prompts.at(-1)).toBe(
      'Continue a tarefa "Login por e-mail" (login) do roadmap, que já está em andamento. Ao terminar, marque como feita no roadmap (roadmap_update), com a evidência do que foi feito.',
    )
    await band.press({ key: 'roadmap-view' })
    expect(seen.opened.at(-1)).toBe('roadmap')
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    for (const text of [
      'Farol · até o beta',
      'atualizado em 2026-10-01 · docs/roadmap.json',
      '▶ Fase 2 Beta fechado',
      '16% · 1/6 · em andamento',
      '✓ Fase 1 Protótipo',
      'Próximas',
      '○ Página do produto · Claude · Fase 3',
      'Com você agora (1)',
      '○ Aprovar o ícone · você',
      'Com você depois (2)',
      '○ Convidar os testadores · você · depende de: Login por e-mail',
      '1 item com você em outras fases',
      'Esperando (1)',
      '‖ Conta de desenvolvedor na loja · você e Claude · espera: aprovação do cartão',
      'feitos (1)',
      '✓ Sincronizar notas · Claude · 2026-10-02',
      'Feitos em outras fases: 1 (Fase 1: 1)',
      '1 decisão em aberto de outras fases',
    ]) {
      expect(await pane.find({ type: 'Text', text }), `${surface}: ${text}`).toBeDefined()
    }
    // O que é de outra fase só entra na contagem.
    expect(await pane.find({ type: 'Text', text: /Publicar na loja/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /Cobrar assinatura/ })).toBeUndefined()
    expect((await pane.findAll({ type: 'Svg' })).length).toBe(surface === 'desktop' ? 3 : 0)
    await pane.press({ key: 'ask-icone' })
    expect(seen.prompts.at(-1)).toMatch(/^Me ajude com a tarefa "Aprovar o ícone" \(icone\)/)
    await pane.unmount()
  }

  // Ocultar: some até o roadmap mudar.
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  await band.press({ key: 'roadmap-hide' })
  expect(await band.find({ text: /Roadmap/ })).toBeUndefined()
  await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'login', status: 'done' } as never)
  // Com o login feito, convidar os testadores fica livre: dois com você agora.
  expect((await band.find({ type: 'Text', text: /^Roadmap · / }))?.text).toBe(
    'Roadmap · Fase 2 Beta fechado · 33% · Próxima: Modo escuro (Claude) · 2 com você agora',
  )
})

test('roadmap grande: a faixa corta o título e o painel corta as listas', async ($, on) => {
  const files: Record<string, string> = { [FILE]: bigText() }
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  const r = roadmap(files[FILE])
  const s = summarize(r)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    const head = (await band.find({ type: 'Text', text: /^Roadmap · / }))?.text ?? ''
    expect(head).toBe(`Roadmap · Fase 3 Etapa 3 · ${s.current?.pct}% · Próxima: ${cut(s.next[0]!.title, 55)} (você e Claude) · ${s.mineNow.length} com você agora`)
    expect(head).toContain('…')
    expect(head.length).toBeLessThan(140)
    await band.unmount()

    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    // Antes, uns 600 textos e quase 300 linhas de item; agora no máximo 6 por lista:
    // próximas (5), com você agora e depois, esperando, a fazer e bloqueados da fase (6 cada) e 3 feitos.
    expect((await pane.findAll({ type: 'Text', text: /^[✓▶○‖] (?!Fase \d)/ })).length).toBeLessThanOrEqual(5 + 5 * 6 + 3)
    expect((await pane.findAll({ type: 'Text' })).length).toBeLessThan(150)
    expect(await pane.find({ type: 'Text', text: `Com você agora (${s.mineNow.length})` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `… e mais ${s.mineNow.length - 6}` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `${s.mineElsewhere} itens com você em outras fases` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `${s.waitingElsewhere} bloqueados em outras fases` })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: `${s.decisionsElsewhere} decisões em aberto de outras fases` })).toBeDefined()
    const doneHere = r.items.filter(i => i.phase === '3' && i.status === 'done').length
    expect(await pane.find({ type: 'Text', text: `feitos (${doneHere}), os últimos 3` })).toBeDefined()
    await pane.unmount()
  }
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

test('desatualizado: conta os commits depois do último que mexeu no roadmap', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { last: 'abc123', count: 14 })
  await $.session.start(START)
  await seen.clock.settle()
  const warning = 'roadmap desatualizado: 14 commits sem atualizar'

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ type: 'Text', text: warning })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: `⚠ ${warning}` })).toBeDefined()
    await pane.unmount()
  }
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)).toContain(`Aviso: ${warning}.`)
  const ran = await $.command.run(RUN)
  expect(ran.text).toBe(`Roadmap: Fase 2 Beta fechado · 16% · próxima: Login por e-mail (login) · ${warning}`)

  // No limite (10), não avisa.
  seen.git.count = 10
  await $.command.run(RUN)
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /desatualizado/ })).toBeUndefined()
  // Roadmap mexido e ainda não commitado: está sendo atualizado, não avisa.
  seen.git.count = 30
  seen.git.dirty = true
  await $.command.run(RUN)
  expect(await band.find({ text: /desatualizado/ })).toBeUndefined()
  // Arquivo que nunca entrou num commit: sem aviso.
  seen.git.dirty = false
  seen.git.last = undefined
  await $.command.run(RUN)
  expect(await band.find({ text: /desatualizado/ })).toBeUndefined()
})

test('sem git: o roadmap aparece e não há aviso de desatualizado', async ($, on) => {
  const files: Record<string, string> = { [FILE]: TEXT }
  const seen = project(on, files, { missing: true, count: 50 })
  await $.session.start(START)
  await seen.clock.settle()
  const band = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ type: 'Text', text: /^Roadmap · / }))?.text).toBe(HEADLINE)
  expect(await band.find({ text: /desatualizado/ })).toBeUndefined()
})

test('sem roadmap no projeto: nada na faixa nem na linha de status; o status diz onde criar', async ($, on) => {
  const files: Record<string, string> = {}
  const seen = project(on, files)
  await $.session.start(START)
  await seen.clock.settle()
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'roadmap', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /Roadmap/ })).toBeUndefined()
    await band.unmount()
  }
  expect(seen.statuses.every(s => s === undefined)).toBe(true)
  const status = String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)
  expect(status).toMatch(/^Não há roadmap neste projeto \(procurei em docs\/roadmap\.json\)\. Para criar um/)
  const update = await $.tool.call({ tool: 'mcp__roadmap__roadmap_update', id: 'x', status: 'done' } as never)
  expect(update.deny).toMatch(/^Não há roadmap neste projeto/)
  expect(files).toEqual({})

  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'desktop', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  expect(await pane.find({ type: 'Text', text: 'Não há roadmap em docs/roadmap.json.' })).toBeDefined()
  await pane.press({ key: 'roadmap-create' })
  expect(seen.prompts.at(-1)).toMatch(/^Crie o roadmap deste projeto em docs\/roadmap\.json/)
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
    expect(await band.find({ type: 'Text', text: ` · roadmap com erro: ${reason}` })).toBeDefined()
    await band.unmount()
    const pane = await $.ui.mount({ plugin: 'roadmap', surface, component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: `O roadmap tem erro: ${reason}` })).toBeDefined()
    await pane.unmount()
  }
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
  expect(await band.find({ text: /Roadmap/ })).toBeUndefined()
  expect(String((await $.tool.call({ tool: 'mcp__roadmap__roadmap_status' } as never)).result)).toContain(
    'Aviso: roadmap desatualizado: 5 commits sem atualizar.',
  )
  const pane = await $.ui.mount({ plugin: 'roadmap', surface: 'terminal', component: 'Pane', requestId: 'roadmap', props: PANE_PROPS })
  await pane.press({ key: 'ask-modo-escuro' })
  expect(seen.prompts.at(-1)).toBe(
    'Faça a tarefa "Modo escuro" (modo-escuro) do roadmap: marque como em andamento no roadmap ao começar e, ao terminar, como feita, com a evidência do que foi feito.',
  )
  // Sem as ferramentas de escrita, o commit não traz o lembrete.
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)).context).toBeUndefined()
})
