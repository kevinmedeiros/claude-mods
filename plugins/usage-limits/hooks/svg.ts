import type { Totals, Verdict, WindowView } from '../types'
import { windowLength } from './projection'

/** Tons médios: leem bem no tema claro e no escuro do app. */
export const HEX: Record<Verdict, string> = {
  ok: '#2f9e62',
  tight: '#d99a00',
  exhausts: '#e5484d',
  exhausted: '#e5484d',
  unknown: '#8a8f98',
}
const TRACK = '#8a8f98'

export const TOKEN_HEX = {
  input: '#5b8def',
  output: '#b26ad9',
  cacheWrite: '#e0a458',
  cacheRead: '#3fb4c4',
} as const

const clamp = (n: number) => Math.min(100, Math.max(0, n))
const fixed = (n: number) => Math.round(n * 10) / 10

/**
 * Barra de um limite: o uso (cheio), o que o ritmo atual projeta até o reset
 * (hachurado) e um traço onde o uso estaria num ritmo uniforme.
 */
export const limitBarSvg = (
  w: WindowView,
  now: number,
  width: number,
  options: { height?: number; pace?: boolean } = {},
): string => {
  const height = options.height ?? 30
  const barH = Math.max(6, Math.round(height * 0.5))
  const barY = Math.round((height - barH) / 2)
  const r = barH / 2
  const x = (pct: number) => fixed((clamp(pct) / 100) * width)
  const color = HEX[w.verdict]
  const used = x(w.pct)
  const projected = x(w.pctAtReset ?? w.pct)

  const length = windowLength(w.kind)
  const pace =
    options.pace !== false && length !== undefined && w.resetsAt !== undefined
      ? x(((now - (w.resetsAt - length)) / length) * 100)
      : undefined

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    '<defs>',
    `<pattern id="h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`,
    `<rect width="3" height="6" fill="${color}" fill-opacity="0.45"/></pattern>`,
    `<clipPath id="c"><rect x="0" y="${barY}" width="${width}" height="${barH}" rx="${r}"/></clipPath>`,
    '</defs>',
    `<rect x="0" y="${barY}" width="${width}" height="${barH}" rx="${r}" fill="${TRACK}" fill-opacity="0.2"/>`,
    '<g clip-path="url(#c)">',
    projected > used
      ? `<rect x="${used}" y="${barY}" width="${fixed(projected - used)}" height="${barH}" fill="url(#h)"/>`
      : '',
    `<rect x="0" y="${barY}" width="${used}" height="${barH}" fill="${color}"/>`,
    '</g>',
    pace !== undefined
      ? `<line x1="${pace}" y1="${Math.max(1, barY - 4)}" x2="${pace}" y2="${Math.min(height - 1, barY + barH + 4)}" stroke="${TRACK}" stroke-width="2" stroke-linecap="round"/>`
      : '',
    '</svg>',
  ].join('')
}

/** Barra empilhada da composição dos tokens da sessão. */
export const tokenMixSvg = (t: Totals, width: number, height = 12): string => {
  const parts = [
    [t.input, TOKEN_HEX.input],
    [t.output, TOKEN_HEX.output],
    [t.cacheWrite, TOKEN_HEX.cacheWrite],
    [t.cacheRead, TOKEN_HEX.cacheRead],
  ] as const
  const total = parts.reduce((sum, [n]) => sum + n, 0)
  let at = 0
  const rects = parts.map(([n, color]) => {
    const w = total > 0 ? (n / total) * width : 0
    const rect = w > 0 ? `<rect x="${fixed(at)}" y="0" width="${fixed(w)}" height="${height}" fill="${color}"/>` : ''
    at += w

    return rect
  })

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<clipPath id="c"><rect width="${width}" height="${height}" rx="${height / 2}"/></clipPath>`,
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${TRACK}" fill-opacity="0.2"/>`,
    `<g clip-path="url(#c)">${rects.join('')}</g>`,
    '</svg>',
  ].join('')
}
