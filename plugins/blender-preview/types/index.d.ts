export type Budgets = { maxTriangles: number; maxBones: number; maxTextureSize: number }

export type SceneStats = {
  triangles: number
  objects: { name: string; triangles: number }[]
  bones: number
  materials: number
  textures: { name: string; width?: number; height?: number }[]
  actions: string[]
}

export type GlbReport = {
  sizeBytes: number
  triangles: number
  meshes: { name: string; triangles: number }[]
  materials: number
  textures: { name: string; width?: number; height?: number }[]
  bones: number
  animations: string[]
}

export type Preview = {
  /** O PNG da miniatura, em base64. */
  png?: string
  stats?: SceneStats
  at: number
  /** Por que não deu para atualizar (Blender fechado, MCP desconectado...). */
  problem?: string
}

export type GlbCheck = { path: string; report?: GlbReport; problem?: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'blender-preview': { preview: Preview | null; glb: GlbCheck | null; busy: boolean }
  }
}
