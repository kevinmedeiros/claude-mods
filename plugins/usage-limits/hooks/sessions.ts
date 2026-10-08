import type { SessionRecord, SessionsView, Totals } from '../types'
import { DAY, MINUTE, totalTokens } from './projection'

/** Uma sessão sem sinal há mais de 3 min é tratada como fechada. */
export const RUNNING_WINDOW = 3 * MINUTE

export type SessionBook = Record<string, SessionRecord>

const emptyTotals = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 })

/** Grava o registro desta sessão no livro da máquina e descarta os de mais de 2 dias. */
export const upsertSession = (book: SessionBook | undefined, record: SessionRecord, now: number): SessionBook => {
  const next: SessionBook = {}
  for (const [id, r] of Object.entries(book ?? {})) if (now - r.updatedAt < 2 * DAY) next[id] = r
  next[record.id] = record

  return next
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

export const isRunning = (r: SessionRecord, now: number) => !r.ended && now - r.updatedAt < RUNNING_WINDOW

/** As sessões abertas agora (esta primeiro, depois as que mais gastaram) e o total de hoje. */
export const sessionsView = (book: SessionBook | undefined, now: number, selfId: string): SessionsView => {
  const all = Object.values(book ?? {})
  const running = all
    .filter(r => r.id === selfId || isRunning(r, now))
    .sort((a, b) => (a.id === selfId ? -1 : b.id === selfId ? 1 : b.costUsd - a.costUsd))
  const today = all.filter(r => sameDay(r.updatedAt, now))
  const sum = (list: SessionRecord[]) => {
    const tokens = emptyTotals()
    let costUsd = 0
    for (const r of list) {
      tokens.input += r.tokens.input
      tokens.output += r.tokens.output
      tokens.cacheRead += r.tokens.cacheRead
      tokens.cacheWrite += r.tokens.cacheWrite
      tokens.turns += r.tokens.turns
      costUsd += r.costUsd
    }
    return { tokens, costUsd, count: list.length }
  }

  return { running, total: sum(running), today: sum(today) }
}

export const sessionTokens = (r: SessionRecord) => totalTokens(r.tokens)
