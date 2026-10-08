/** Um handoff lido do arquivo do projeto, escrito por outra máquina. */
export type Handoff = {
  machine: string
  /** Quando foi escrito, em ms desde a época. */
  at: number
  text: string
}

declare module 'claude-code' {
  interface PluginState {
    fluxo: {
      /** Handoff de outra máquina ainda não dispensado. */
      incoming: Handoff | null
      /** Arquivos editados nesta sessão, relativos à raiz do projeto. */
      edited: string[]
      /** O último resumo feito por /handoff nesta sessão. */
      summary: string | null
    }
  }
}
