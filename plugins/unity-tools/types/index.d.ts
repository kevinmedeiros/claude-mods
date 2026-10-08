export type CompileError = {
  file: string
  line: number
  column: number
  code: string
  message: string
}

export type TestCase = { name: string; message: string; stack: string }

export type TestRun = {
  platform: string
  total: number
  passed: number
  failed: number
  skipped: number
  durationSec: number
  failures: TestCase[]
}

export type Platform = 'EditMode' | 'PlayMode'

export type TestJob = {
  platform: Platform
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  result?: TestRun
  /** Por que não rodou (editor aberto, licença, erro de compilação...). */
  problem?: string
}

export type BuildJob = {
  status: 'running' | 'done' | 'error'
  startedAt: number
  endedAt?: number
  /** As últimas linhas do log do Unity. */
  lines: string[]
  problem?: string
}

/** O resultado da última checagem de compilação de um assembly. */
export type CompileState = { errors: CompileError[]; at: number }

export type ProjectInfo = {
  root: string
  version?: string
  editor?: string
  hasEditor: boolean
  isWindows: boolean
  hasDotnet: boolean
  /** O módulo Linux Dedicated Server do editor está instalado. */
  hasLinuxServer: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'unity-tools': {
      project: ProjectInfo | null
      compile: Record<string, CompileState>
      tests: Partial<Record<Platform, TestJob>>
      build: BuildJob | null
    }
  }
}
