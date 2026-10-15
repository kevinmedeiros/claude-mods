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

const arcPath = (cx: number, cy: number, r: number, from: number, to: number) => {
  // Ângulos em % do círculo, a partir do topo, no sentido horário.
  const at = (pct: number) => {
    const a = (pct / 100) * 2 * Math.PI - Math.PI / 2
    return `${fixed(cx + r * Math.cos(a))} ${fixed(cy + r * Math.sin(a))}`
  }
  const large = to - from > 50 ? 1 : 0

  return `M ${at(from)} A ${r} ${r} 0 ${large} 1 ${at(to)}`
}

/**
 * Anel de um limite para o painel: o uso cheio, a projeção até o reset mais
 * clara, um traço onde estaria o ritmo uniforme e o % grande no meio.
 */
export const limitRingSvg = (w: WindowView, now: number, size = 96): string => {
  const stroke = Math.round(size * 0.1)
  const r = (size - stroke) / 2 - 1
  const c = size / 2
  const color = w.isRenewed ? HEX.unknown : HEX[w.verdict]
  const used = clamp(w.pct)
  const projected = clamp(w.pctAtReset ?? w.pct)
  const length = windowLength(w.kind)
  const pace =
    length !== undefined && w.resetsAt !== undefined && !w.isRenewed
      ? clamp(((now - (w.resetsAt - length)) / length) * 100)
      : undefined
  const arc = (from: number, to: number, opacity: number) =>
    to - from >= 99.9
      ? `<circle cx="${c}" cy="${c}" r="${fixed(r)}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${stroke}"/>`
      : to - from > 0.2
        ? `<path d="${arcPath(c, c, r, from, to)}" fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${stroke}" stroke-linecap="round"/>`
        : ''
  const tick = (pct: number) => {
    const a = (pct / 100) * 2 * Math.PI - Math.PI / 2
    const r1 = r - stroke / 2 - 2
    const r2 = r + stroke / 2 + 2
    return `<line x1="${fixed(c + r1 * Math.cos(a))}" y1="${fixed(c + r1 * Math.sin(a))}" x2="${fixed(c + r2 * Math.cos(a))}" y2="${fixed(c + r2 * Math.sin(a))}" stroke="${TRACK}" stroke-width="2" stroke-linecap="round"/>`
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
    `<circle cx="${c}" cy="${c}" r="${fixed(r)}" fill="none" stroke="${TRACK}" stroke-opacity="0.2" stroke-width="${stroke}"/>`,
    projected > used ? arc(used, projected, 0.3) : '',
    arc(0, used, 1),
    pace !== undefined ? tick(pace) : '',
    `<text x="${c}" y="${fixed(c + size * 0.08)}" text-anchor="middle" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="${Math.round(size * 0.24)}" font-weight="700" fill="${color}">${Math.round(w.pct)}%</text>`,
    '</svg>',
  ].join('')
}

/** Barrinha de participação (sessões, projetos). */
export const shareSvg = (share: number, width = 64, height = 8, color = '#5b8def'): string =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" rx="${height / 2}" fill="${TRACK}" fill-opacity="0.2"/>`,
    share > 0
      ? `<rect width="${fixed(Math.max(height, clamp(share * 100) / 100 * width))}" height="${height}" rx="${height / 2}" fill="${color}"/>`
      : '',
    '</svg>',
  ].join('')
