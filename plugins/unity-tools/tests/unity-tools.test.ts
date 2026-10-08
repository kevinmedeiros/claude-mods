import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { guard, parseCompileErrors, parseTestResults, projectReferences, testSummary } from '../hooks/unity'

const ROOT = '/Users/k/MMORPG/client/AwakenFront'
const CFG = { root: ROOT, coreDir: 'Assets/Scripts/Core', allowSceneEdits: false }

// Trecho no formato do XML real do Unity 6 (NUnit 3), com uma falha.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="3" result="Failed" total="3" passed="2" failed="1" inconclusive="0" skipped="0" duration="0.0229666">
  <test-suite type="TestSuite" name="AwakenFront" fullname="AwakenFront" total="3" passed="2" failed="1">
    <test-case id="1006" name="Awakening_RequiresLevel6AndPath" fullname="AwakenFront.Core.Tests.DodgeAndProgressionTests.Awakening_RequiresLevel6AndPath" methodname="Awakening_RequiresLevel6AndPath" result="Passed" duration="0.005042"><properties /></test-case>
    <test-case id="1007" name="Dodge_CostsStamina" fullname="AwakenFront.Core.Tests.DodgeAndProgressionTests.Dodge_CostsStamina" methodname="Dodge_CostsStamina" result="Failed" duration="0.001596">
      <failure>
        <message><![CDATA[  Expected: 35
  But was:  30
]]></message>
        <stack-trace><![CDATA[at AwakenFront.Core.Tests.DodgeAndProgressionTests.Dodge_CostsStamina () [0x00011] in Assets/Tests/EditMode/DodgeTests.cs:42
]]></stack-trace>
      </failure>
    </test-case>
    <test-case id="1008" name="Sprint_Toggles" fullname="AwakenFront.Core.Tests.SprintTests.Sprint_Toggles" result="Passed"><properties /></test-case>
  </test-suite>
</test-run>`

test('lê o XML de testes do Unity', () => {
  const r = parseTestResults(XML, 'EditMode')
  expect(r?.total).toBe(3)
  expect(r?.failed).toBe(1)
  expect(r?.failures[0]?.name).toBe('AwakenFront.Core.Tests.DodgeAndProgressionTests.Dodge_CostsStamina')
  expect(r?.failures[0]?.message).toBe('Expected: 35\n  But was:  30')
  expect(r?.failures[0]?.stack).toContain('DodgeTests.cs:42')
  expect(r && testSummary(r)).toBe('EditMode 2/3 · 1 falha')
  expect(parseTestResults('<html/>', 'EditMode')).toBeUndefined()
})

test('lê os erros do dotnet build (formato real, em português)', () => {
  const out = [
    `${ROOT}/Assets/Scripts/Core/Dodge.cs(12,9): error CS0103: O nome "Foo" não existe no contexto atual [${ROOT}/AwakenFront.Core.csproj]`,
    `${ROOT}/Assets/Scripts/Core/Dodge.cs(12,9): error CS0103: O nome "Foo" não existe no contexto atual [${ROOT}/AwakenFront.Core.csproj]`,
    `CSC : error CS2001: Não foi possível encontrar o arquivo de origem "${ROOT}/Assets/Old.cs". [${ROOT}/AwakenFront.Core.csproj]`,
    `${ROOT}/Assets/Scripts/Core/Dodge.cs(3,1): warning CS0168: variável declarada mas nunca usada`,
  ].join('\n')
  const errors = parseCompileErrors(out, ROOT)
  expect(errors).toEqual([
    { file: 'Assets/Scripts/Core/Dodge.cs', line: 12, column: 9, code: 'CS0103', message: 'O nome "Foo" não existe no contexto atual' },
  ])
})

test('lê as referências entre assemblies', () => {
  const csproj = '<ProjectReference Include="AwakenFront.Core.csproj">\n<ProjectReference Include="..\\x\\FishNet.Runtime.csproj" />'
  expect(projectReferences(csproj)).toEqual(['AwakenFront.Core', 'FishNet.Runtime'])
})

test('guardas: pastas geradas, cenas, .meta e núcleo sem engine', () => {
  expect(guard({ tool: 'Edit', path: `${ROOT}/Library/x.txt`, newText: '' }, CFG)).toMatch(/Library\/ é gerado/)
  expect(guard({ tool: 'Write', path: `${ROOT}/Assets/Scenes/Main.unity`, newText: '' }, CFG)).toMatch(/cenas ou prefabs/)
  expect(guard({ tool: 'Write', path: `${ROOT}/Assets/Scenes/Main.unity`, newText: '' }, { ...CFG, allowSceneEdits: true })).toBeUndefined()
  expect(guard({ tool: 'Write', path: `${ROOT}/Assets/a.cs.meta`, newText: 'guid', exists: false }, CFG)).toMatch(/\.meta à mão/)
  expect(guard({ tool: 'Edit', path: `${ROOT}/Assets/tex.png.meta`, newText: 'maxTextureSize: 512' }, CFG)).toBeUndefined()
  expect(guard({ tool: 'Write', path: `${ROOT}/Assets/Scripts/Core/X.cs`, newText: 'using UnityEngine;\nclass X {}' }, CFG)).toMatch(/núcleo de regras/)
  expect(guard({ tool: 'Edit', path: `${ROOT}/Assets/Scripts/Core/X.cs`, newText: 'var p = UnityEngine.Vector3.zero;' }, CFG)).toMatch(/núcleo/)
  expect(guard({ tool: 'Write', path: `${ROOT}/Assets/Scripts/Game/X.cs`, newText: 'using UnityEngine;' }, CFG)).toBeUndefined()
  expect(guard({ tool: 'Edit', path: `${ROOT}/Assets/Scripts/Core/AwakenFront.Core.asmdef`, newText: '"noEngineReferences": false' }, CFG)).toMatch(/noEngineReferences/)
  expect(guard({ tool: 'Bash', command: 'rm Assets/Old.cs.meta' }, CFG)).toMatch(/\.meta/)
  expect(guard({ tool: 'Bash', command: 'git rm -r Assets/Old Assets/Old.meta' }, CFG)).toMatch(/\.meta/)
  expect(guard({ tool: 'Bash', command: 'ls Assets/*.meta' }, CFG)).toBeUndefined()
  expect(guard({ tool: 'Write', path: '/outro/projeto/Library/x', newText: '' }, CFG)).toBeUndefined()
})

/** Um projeto Unity de mentira por baixo do plugin. */
const unityProject = (on: On, buildOutput: string) => {
  const files: Record<string, string> = {
    [`${ROOT}/ProjectSettings/ProjectVersion.txt`]: 'm_EditorVersion: 6000.6.3f1\n',
    [`${ROOT}/Assets/Scripts/Core/AwakenFront.Core.asmdef`]: '{ "name": "AwakenFront.Core" }',
    [`${ROOT}/AwakenFront.Core.csproj`]: '<Project><Compile Include="Assets/Scripts/Core/Dodge.cs" /></Project>',
    '/Applications/Unity/Hub/Editor/6000.6.3f1/Unity.app/Contents/MacOS/Unity': '',
  }
  const runs: string[][] = []
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files }))
  on('fs.read', ($, e) => (e.path in files ? { value: files[e.path]! } : { deny: 'missing' }))
  on('fs.write', ($, e) => ((files[e.path] = e.text), { value: undefined }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const names = new Set<string>()
    for (const f of Object.keys(files)) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]!)
    return {
      value: [...names].map(name => ({
        name,
        kind: Object.keys(files).some(f => f.startsWith(`${prefix}${name}/`)) ? ('dir' as const) : ('file' as const),
        size: 0,
        mtimeMs: 0,
        isLink: false,
      })),
    }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const stdout = e.argv[0] === 'dotnet' && e.argv[1] === 'build' ? buildOutput : '10.0.401'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__unity-tools__${e.name}` } }))
  on('ui.status', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { type: 'update' } }) as never)

  return { files, runs }
}

test('Write no núcleo com UnityEngine é recusado', async ($, on) => {
  unityProject(on, '')
  await $.session.start({ cwd: '/Users/k/MMORPG', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/Assets/Scripts/Core/X.cs`, content: 'using UnityEngine;' })
  expect(ran.deny ?? (ran.isError ? ran.text : undefined)).toContain('núcleo de regras')
})

test('editar um .cs entrega os erros de compilação ao Claude', async ($, on) => {
  const { runs, files } = unityProject(
    on,
    `${ROOT}/Assets/Scripts/Core/New.cs(4,5): error CS0246: O nome do tipo "Foo" não pode ser encontrado [${ROOT}/AwakenFront.Core.csproj]`,
  )
  await $.session.start({ cwd: '/Users/k/MMORPG', surface: 'terminal', isInteractive: true })
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/Assets/Scripts/Core/New.cs`, content: 'class New { Foo f; }' })

  expect(ran.context?.[0]).toContain('Compilação Unity (AwakenFront.Core, via dotnet build): 1 erro.')
  expect(ran.context?.[0]).toContain('Assets/Scripts/Core/New.cs(4,5): CS0246')
  const build = runs.find(r => r[1] === 'build')
  expect(build?.[2]).toBe('AwakenFront.Core.csproj')
  // O arquivo novo entra pelo .targets, fora do projeto.
  expect(files[`${ROOT}/Temp/claude-check/extra-AwakenFront.Core.targets`]).toContain('Core/New.cs')
})
