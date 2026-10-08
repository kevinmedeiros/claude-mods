import { expect, mock, test } from 'claude-code/testing'

import { exportPath, fromBase64, glbText, parseGlb, parseStats, warnings } from '../hooks/glb'
import { GLB_BASE64 } from './fixture-glb'

const BUDGETS = { maxTriangles: 20_000, maxBones: 100, maxTextureSize: 2048 }

test('lê um GLB real do Blender', () => {
  const r = parseGlb(fromBase64(GLB_BASE64))
  expect(r?.triangles).toBe(224)
  expect(r?.meshes.length).toBe(1)
  expect(r?.materials).toBe(1)
  expect(r?.bones).toBe(2)
  expect(r?.animations).toEqual(['Andar'])
  expect(r?.textures[0]).toEqual({ name: 'pele', width: 64, height: 32 })
  expect(r && warnings(r, BUDGETS)).toEqual([])
  expect(r && warnings(r, { ...BUDGETS, maxTextureSize: 32, maxTriangles: 100 })).toEqual([
    '224 triângulos, acima do orçamento de 100',
    'textura pele com 64×32, acima de 32',
  ])
  expect(parseGlb(new Uint8Array([1, 2, 3]))).toBeUndefined()
})

test('acha o caminho do export e lê as medidas da cena', () => {
  expect(exportPath('bpy.ops.export_scene.gltf(filepath="/tmp/heroi.glb", export_format="GLB")')).toBe('/tmp/heroi.glb')
  expect(exportPath("bpy.ops.export_scene.gltf(filepath=r'C:\\arte\\heroi.glb')")).toBe('C:\\arte\\heroi.glb')
  expect(exportPath('bpy.ops.mesh.primitive_cube_add()')).toBeUndefined()
  const stats = parseStats('{"triangles": 224, "objects": [["Corpo", 224]], "bones": 2, "materials": 1, "textures": [["Pele", 64, 32]], "actions": ["Andar"]}')
  expect(stats?.objects).toEqual([{ name: 'Corpo', triangles: 224 }])
  expect(stats?.textures).toEqual([{ name: 'Pele', width: 64, height: 32 }])
  expect(parseStats('Error: no result')).toBeUndefined()
})

test('export pelo Blender MCP entrega o relatório do GLB ao Claude', async ($, on) => {
  mock.clock(on, { now: 0 })
  mock.store(on)
  on('fs.stat', () => ({ value: { kind: 'file', size: 30_264, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: GLB_BASE64 } }))
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: 'ok' }] } }) as never)
  const ran = await $.tool.call({
    tool: 'mcp__Blender__execute_blender_code',
    code: 'bpy.ops.export_scene.gltf(filepath="/arte/heroi.glb", export_format="GLB")',
  } as never)
  expect(ran.context?.[0]).toContain('Export GLB /arte/heroi.glb: 30 KB, 224 triângulos em 1 malha(s)')
  expect(ran.context?.[0]).toContain('2 osso(s), 1 animação(ões) (Andar)')
  expect(glbText('/x.glb', parseGlb(fromBase64(GLB_BASE64))!, { ...BUDGETS, maxBones: 1 })).toContain('⚠ 2 ossos, acima do limite de 1')
})
