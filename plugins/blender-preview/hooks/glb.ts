import type { Budgets, GlbReport, SceneStats } from '../types'

const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
const be32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
const be16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 para bytes, sem depender de atob nem de Uint8Array.fromBase64. */
export const fromBase64 = (text: string): Uint8Array => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]!) << 18) |
      (B64.indexOf(clean[i + 1] ?? 'A') << 12) |
      ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) |
      (B64.indexOf(clean[i + 3] ?? 'A') & 63)
    out[o++] = (n >> 16) & 255
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255
    if (i + 3 < clean.length) out[o++] = n & 255
  }

  return out.subarray(0, o)
}

/** Largura e altura de um PNG ou JPEG pelos bytes do cabeçalho. */
export const imageSize = (b: Uint8Array): { width: number; height: number } | undefined => {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: be32(b, 16), height: be32(b, 20) }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined
      const marker = b[i + 1]!
      const length = be16(b, i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: be16(b, i + 5), width: be16(b, i + 7) }
      }
      i += 2 + length
    }
  }

  return undefined
}

type Gltf = {
  meshes?: { name?: string; primitives?: { indices?: number; attributes?: { POSITION?: number } }[] }[]
  accessors?: { count?: number }[]
  materials?: unknown[]
  images?: { name?: string; uri?: string; bufferView?: number; mimeType?: string }[]
  bufferViews?: { byteOffset?: number; byteLength?: number }[]
  skins?: { joints?: number[] }[]
  animations?: { name?: string }[]
}

/** Lê um .glb (binário do glTF 2.0): malhas, triângulos, ossos, animações e texturas. */
export const parseGlb = (bytes: Uint8Array, sizeBytes = bytes.length): GlbReport | undefined => {
  if (bytes.length < 20 || u32(bytes, 0) !== 0x46546c67) return undefined
  const jsonLength = u32(bytes, 12)
  if (u32(bytes, 16) !== 0x4e4f534a) return undefined
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as Gltf
  let bin: Uint8Array | undefined
  const binAt = 20 + jsonLength
  if (binAt + 8 <= bytes.length && u32(bytes, binAt + 4) === 0x004e4942) {
    bin = bytes.subarray(binAt + 8, binAt + 8 + u32(bytes, binAt))
  }

  let triangles = 0
  const meshes = (gltf.meshes ?? []).map((mesh, i) => {
    let tris = 0
    for (const prim of mesh.primitives ?? []) {
      const accessor = prim.indices ?? prim.attributes?.POSITION
      tris += Math.floor((gltf.accessors?.[accessor ?? -1]?.count ?? 0) / 3)
    }
    triangles += tris
    return { name: mesh.name ?? `mesh ${i}`, triangles: tris }
  })
  const textures = (gltf.images ?? []).map((img, i) => {
    const view = img.bufferView !== undefined ? gltf.bufferViews?.[img.bufferView] : undefined
    const data = view && bin ? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0)) : undefined
    const size = data ? imageSize(data) : undefined
    return { name: img.name ?? img.uri ?? `imagem ${i}`, width: size?.width, height: size?.height }
  })

  return {
    sizeBytes,
    triangles,
    meshes: meshes.sort((a, b) => b.triangles - a.triangles),
    materials: gltf.materials?.length ?? 0,
    textures,
    bones: Math.max(0, ...(gltf.skins ?? []).map(s => s.joints?.length ?? 0)),
    animations: (gltf.animations ?? []).map((a, i) => a.name ?? `animação ${i}`),
  }
}

/** Avisos contra os orçamentos do jogo. */
export const warnings = (
  stats: { triangles: number; bones: number; textures: { name: string; width?: number; height?: number }[] },
  budgets: Budgets,
): string[] => {
  const out: string[] = []
  if (stats.triangles > budgets.maxTriangles) {
    out.push(`${stats.triangles.toLocaleString('pt-BR')} triângulos, acima do orçamento de ${budgets.maxTriangles.toLocaleString('pt-BR')}`)
  }
  if (stats.bones > budgets.maxBones) out.push(`${stats.bones} ossos, acima do limite de ${budgets.maxBones}`)
  for (const t of stats.textures) {
    const side = Math.max(t.width ?? 0, t.height ?? 0)
    if (side > budgets.maxTextureSize) out.push(`textura ${t.name} com ${t.width}×${t.height}, acima de ${budgets.maxTextureSize}`)
  }

  return out
}

const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)

export const glbText = (path: string, r: GlbReport, budgets: Budgets) => {
  const warn = warnings(r, budgets)
  const lines = [
    `Export GLB ${path}: ${kb(r.sizeBytes)}, ${r.triangles.toLocaleString('pt-BR')} triângulos em ${r.meshes.length} malha(s), ` +
      `${r.materials} material(is), ${r.textures.length} textura(s), ${r.bones} osso(s), ${r.animations.length} animação(ões)` +
      (r.animations.length > 0 ? ` (${r.animations.slice(0, 8).join(', ')})` : '') +
      '.',
  ]
  if (r.animations.length > 0 && r.bones === 0) lines.push('⚠ Há animações mas nenhuma skin: confira se o rig foi exportado.')
  for (const w of warn) lines.push(`⚠ ${w}`)

  return lines.join('\n')
}

/** O script que o Blender roda para medir a cena. */
export const STATS_CODE = `
import bpy
deps = bpy.context.evaluated_depsgraph_get()
objs = []
tris = 0
for o in bpy.context.scene.objects:
    if o.type != 'MESH' or not o.visible_get():
        continue
    e = o.evaluated_get(deps)
    m = e.to_mesh()
    m.calc_loop_triangles()
    t = len(m.loop_triangles)
    e.to_mesh_clear()
    tris += t
    objs.append([o.name, t])
objs.sort(key=lambda x: -x[1])
arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
result = {
    "triangles": tris,
    "objects": objs[:8],
    "bones": max([len(a.data.bones) for a in arms] or [0]),
    "materials": len([m for m in bpy.data.materials if m.users]),
    "textures": [[i.name, i.size[0], i.size[1]] for i in bpy.data.images if i.users and i.size[0]],
    "actions": [a.name for a in bpy.data.actions][:12],
}
`

/** O dicionário `result` que o Blender MCP devolve em texto. */
export const parseStats = (text: string): SceneStats | undefined => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const data = (raw.result && typeof raw.result === 'object' ? raw.result : raw) as {
      triangles?: number
      objects?: [string, number][]
      bones?: number
      materials?: number
      textures?: [string, number, number][]
      actions?: string[]
    }
    if (typeof data.triangles !== 'number') return undefined
    return {
      triangles: data.triangles,
      objects: (data.objects ?? []).map(([name, triangles]) => ({ name, triangles })),
      bones: data.bones ?? 0,
      materials: data.materials ?? 0,
      textures: (data.textures ?? []).map(([name, width, height]) => ({ name, width, height })),
      actions: data.actions ?? [],
    }
  } catch {
    return undefined
  }
}

/** O caminho do .glb num script de export do Blender. */
export const exportPath = (code: string): string | undefined => {
  if (!/export_scene\.gltf/.test(code)) return undefined
  return /filepath\s*=\s*r?["']([^"']+\.glb)["']/i.exec(code)?.[1]
}
