export type Section = 'Active' | 'Waiting On' | 'Someday' | 'Done'

export type Task = {
  /** O título normalizado: a chave para achar e não duplicar. */
  id: string
  title: string
  context?: string
  done: boolean
  section: Section
  /** A linha do TASKS.md onde a tarefa está. */
  line: number
  doneAt?: string
}

/** O TASKS.md do projeto como o mod o leu por último. */
export type Board = {
  path: string
  project: string
  exists: boolean
  tasks: Task[]
  /** Quando o arquivo mudou por último (para notar edições feitas fora do mod). */
  mtimeMs: number
}

declare module 'claude-code' {
  interface PluginState {
    tarefas: { board: Board | null; notice: string | null }
  }
}
