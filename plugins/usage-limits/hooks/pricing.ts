import type { Tokens } from '../types'

/** US$ por milhão de tokens, preço de API (tabela de 2026-10). */
type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }

const p = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead,
})

const PRICES: Record<string, Price> = {
  'fable-5-1': p(10, 50, 0.25),
  'fable-5': p(10, 50, 1),
  'mythos-5-1': p(10, 50, 0.25),
  'opus-5-5': p(4, 20, 0.2),
  'opus-5': p(5, 25, 0.5),
  'opus-4-8': p(5, 25, 0.5),
  'opus-4-7': p(5, 25, 0.5),
  'opus-4-6': p(5, 25, 0.5),
  'opus-4-5': p(5, 25, 0.5),
  'opus-4-1': p(15, 75, 1.5),
  'opus-4': p(15, 75, 1.5),
  'sonnet-5-5': p(2, 10, 0.2),
  'sonnet-5': p(2, 10, 0.2),
  'sonnet-4-6': p(3, 15, 0.3),
  'sonnet-4-5': p(3, 15, 0.3),
  'sonnet-4': p(3, 15, 0.3),
  'haiku-5-5': p(0.1, 0.5, 0.01),
  'haiku-4-5': p(1, 5, 0.1),
}

/** Modelo atual de cada família, para ids que a tabela não conhece. */
const LATEST: Record<string, string> = {
  fable: 'fable-5-1',
  mythos: 'mythos-5-1',
  opus: 'opus-5-5',
  sonnet: 'sonnet-5-5',
  haiku: 'haiku-5-5',
}

export const HAIKU = 'haiku-5-5'
export const SONNET = 'sonnet-5-5'
export const HAIKU_ID = 'claude-haiku-5-5'

/** `claude-opus-5-5[1m]`, `claude-opus-4-5-20251101` → `opus-5-5`, `opus-4-5`. */
export const modelKey = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/.exec(id.toLowerCase())
  if (!m) return id
  const key = m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`

  return PRICES[key] ? key : (LATEST[m[1] ?? ''] ?? key)
}

export const family = (key: string) => key.split('-')[0] ?? key

/** `opus-5-5` → `Opus 5.5`. */
export const modelLabel = (key: string): string => {
  const [name = key, ...version] = key.split('-')

  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${version.join('.')}`.trim()
}

const priceOf = (key: string): Price => PRICES[key] ?? PRICES[LATEST[family(key)] ?? ''] ?? p(4, 20, 0.2)

/** Custo em US$ de um lote de tokens num modelo. */
export const costOf = (t: Tokens, key: string): number => {
  const price = priceOf(key)

  return (
    (t.input * price.input +
      t.output * price.output +
      t.cacheWrite * price.cacheWrite +
      t.cacheRead * price.cacheRead) /
    1e6
  )
}
