// Generates the README preview images from the mods' own drawing code.
// Run from the repository root:  bun docs/generate-previews.ts
import { writeFileSync } from 'node:fs'

import { clockTime, hours, percent, project, statusPart } from '../plugins/usage-limits/hooks/projection'
import { limitBarSvg, tokenMixSvg } from '../plugins/usage-limits/hooks/svg'

const NOW = Date.parse('2026-10-09T13:00:00Z')
const HOUR = 3_600_000
const five = project({ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 2.1 * HOUR).toISOString() }, NOW)
// 41% after 36h of a 168h week: at this pace it runs out before the reset.
const week = project({ kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 132 * HOUR).toISOString() }, NOW, undefined, undefined, {
  fiveRate: 2.2,
  weekPerFive: 0.25,
  activeHoursPerDay: 8,
})
const h = (ms: number) => hours(ms / HOUR)
const fiveLeft = `~${hours(five.hoursLeft ?? 0)}`
const weekLeft = `~${hours(week.hoursLeft ?? 0)}`
const fiveColor = five.verdict === 'ok' ? '#3fb950' : '#d29922'
const weekColor = week.verdict === 'exhausts' ? '#f85149' : week.verdict === 'tight' ? '#d29922' : '#3fb950'
const weekVerdict =
  week.verdict === 'exhausts' && week.exhaustAt !== undefined && week.resetsAt !== undefined
    ? `⚠ No ritmo atual acaba ~${clockTime(week.exhaustAt, NOW)}, ${hours((week.resetsAt - week.exhaustAt) / HOUR)} antes do reset`
    : `✓ Dura até o reset (~${percent(week.pctAtReset ?? 0)} no fim)`

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
const SANS = '-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif'
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** An inline <svg> placed at (x, y), taken from a full SVG document string. */
const nest = (svg: string, x: number, y: number) => svg.replace('<svg ', `<svg x="${x}" y="${y}" `)

// ---------- terminal ----------

type Span = { text: string; color?: string; bold?: boolean }
const line = (y: number, spans: Span[], x = 24) => {
  const tspans = spans
    .map(s => `<tspan fill="${s.color ?? '#c9d1d9'}"${s.bold ? ' font-weight="700"' : ''}>${esc(s.text)}</tspan>`)
    .join('')
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="13" xml:space="preserve">${tspans}</text>`
}
const G = '#3fb950'
const Y = '#d29922'
const R = '#f85149'
const DIM = '#8b949e'

const terminal = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="300" viewBox="0 0 1000 300">`,
  `<rect width="1000" height="300" rx="10" fill="#0d1117"/>`,
  `<rect width="1000" height="32" rx="10" fill="#161b22"/><rect y="22" width="1000" height="10" fill="#161b22"/>`,
  `<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/><circle cx="60" cy="16" r="6" fill="#28c840"/>`,
  `<text x="500" y="21" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${DIM}">claude — my-game</text>`,
  line(66, [
    { text: '5h ', bold: true }, { text: '███░░░░░', color: fiveColor }, { text: ' 38% ', color: fiveColor, bold: true },
    { text: `dura ${fiveLeft} · reset ${h(five.msToReset ?? 0)}   `, color: DIM },
    { text: 'Sem ', bold: true }, { text: '███░░░░░', color: weekColor }, { text: ' 41% ', color: weekColor, bold: true },
    { text: `dura ${weekLeft} · reset ${h(week.msToReset ?? 0)}`, color: DIM },
  ]),
  line(86, [{ text: '3 sessões · 6.3M tokens · US$ 9,91 · API US$ 37/200 · /limites', color: DIM }]),
  line(112, [{ text: '💡 Você está usando Opus 5.5 e 64% do gasto vem de subagentes em Opus 5.5. Para não ficar', color: Y }]),
  line(130, [{ text: '   sem uso, use Opus 5.5 para orquestrar e Haiku para executar: o limite semanal passa a', color: Y }]),
  line(148, [{ text: '   durar ~140h e seu plano dura até o reset (~82% no fim).', color: Y }]),
  line(172, [{ text: '[ Haiku nos subagentes ]', color: '#58a6ff', bold: true }, { text: '   ↻ Atualizar', color: DIM }]),
  `<line x1="24" y1="196" x2="976" y2="196" stroke="#30363d"/>`,
  line(220, [{ text: '❯ ', color: '#d2a8ff' }, { text: 'Implement the dodge window and run the EditMode tests', color: '#c9d1d9' }]),
  `<line x1="24" y1="238" x2="976" y2="238" stroke="#30363d"/>`,
  line(262, [
    { text: `  ${statusPart(five)} │ ${statusPart(week)} │ 3 sessões · 6.3M tok · US$ 9,91`, color: DIM },
  ]),
  line(282, [{ text: '  Unity · ✓ compila · EditMode 15/15 ✓', color: G }]),
  `</svg>`,
].join('\n')

// ---------- desktop pane ----------

const card = (y: number, h: number, border: string) =>
  `<rect x="20" y="${y}" width="640" height="${h}" rx="10" fill="#ffffff" stroke="${border}" stroke-width="1.5"/>`
const t = (x: number, y: number, text: string, opts: { size?: number; color?: string; bold?: boolean; anchor?: string } = {}) =>
  `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${opts.size ?? 13}" fill="${opts.color ?? '#1f2328'}"${opts.bold ? ' font-weight="600"' : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}>${esc(text)}</text>`
const stat = (x: number, y: number, label: string, value: string, color?: string) =>
  t(x, y, label, { size: 11, color: '#656d76' }) + t(x, y + 18, value, { bold: true, color })

const desktop = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="470" viewBox="0 0 680 470">`,
  `<rect width="680" height="470" rx="12" fill="#f6f8fa"/>`,
  t(24, 34, 'Limites de uso', { size: 15, bold: true }),
  t(656, 34, 'atualizado 10:00  ↻ Atualizar', { size: 12, color: '#656d76', anchor: 'end' }),
  card(50, 150, five.verdict === 'ok' ? '#2f9e62' : '#d99a00'),
  t(36, 76, '5 horas', { bold: true }),
  t(644, 76, '38% usado', { bold: true, color: '#2f9e62', anchor: 'end' }),
  nest(limitBarSvg(five, NOW, 608), 36, 84),
  stat(36, 134, 'Duração estimada', fiveLeft, '#2f9e62'),
  stat(196, 134, 'Reset em', `${h(five.msToReset ?? 0)} · ${clockTime(five.resetsAt ?? NOW, NOW)}`),
  stat(356, 134, 'Ritmo recente', `${Math.round(five.ratePerHour ?? 0)}%/h`),
  stat(500, 134, 'Média da janela', `${Math.round(five.windowRatePerHour ?? 0)}%/h`),
  t(36, 188, `✓ Dura até o reset (~${percent(five.pctAtReset ?? 0)} no fim)`, { color: '#2f9e62' }),
  card(214, 150, weekColor === '#f85149' ? '#e5484d' : weekColor),
  t(36, 240, 'Semanal', { bold: true }),
  t(644, 240, '41% usado', { bold: true, color: weekColor === '#f85149' ? '#e5484d' : weekColor, anchor: 'end' }),
  nest(limitBarSvg(week, NOW, 608), 36, 248),
  stat(36, 298, 'Duração estimada', weekLeft, '#e5484d'),
  stat(196, 298, 'Reset em', `${h(week.msToReset ?? 0)} · ${clockTime(week.resetsAt ?? NOW, NOW)}`),
  stat(356, 298, 'Ritmo da conta', `${Math.round((week.ratePerHour ?? 0) * 24)} pts/dia`),
  stat(500, 298, 'Horas de uso', `~${hours(week.workHoursLeft ?? 0)}`),
  t(36, 352, weekVerdict, { color: '#e5484d' }),
  card(378, 76, '#d0d7de'),
  t(36, 402, 'Esta sessão', { bold: true }),
  nest(tokenMixSvg({ input: 120_000, output: 480_000, cacheWrite: 900_000, cacheRead: 4_800_000, turns: 0 }, 608), 36, 412),
  `<text x="36" y="444" font-family="${SANS}" font-size="11" fill="#656d76">` +
    [['#5b8def', 'entrada 120k'], ['#b26ad9', 'saída 480k'], ['#e0a458', 'cache escrito 900k'], ['#3fb4c4', 'cache lido 4.8M']]
      .map(([c, label]) => `<tspan fill="${c}">■</tspan> ${label}   `)
      .join('') +
    `</text>`,
  `</svg>`,
].join('\n')

writeFileSync(new URL('./terminal.svg', import.meta.url), terminal)
writeFileSync(new URL('./desktop-pane.svg', import.meta.url), desktop)
console.log('docs/terminal.svg and docs/desktop-pane.svg written')
