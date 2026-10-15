// Generates the README preview images from the mods' own drawing code.
// Run from the repository root:  bun docs/generate-previews.ts
import { writeFileSync } from 'node:fs'

import { clockTime, duration, hours, percent, project, statusPart } from '../plugins/usage-limits/hooks/projection'
import { limitRingSvg, shareSvg } from '../plugins/usage-limits/hooks/svg'

const NOW = Date.parse('2026-10-09T13:00:00Z')
const HOUR = 3_600_000
const five = project({ kind: 'five_hour', percentUsed: 38, resetsAt: new Date(NOW + 2.1 * HOUR).toISOString() }, NOW)
// 41% after 36h of a 168h week: at this pace it runs out before the reset.
const week = project({ kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 132 * HOUR).toISOString() }, NOW, undefined, undefined, {
  fiveRate: 2.2,
  weekPerFive: 0.25,
  activeHoursPerDay: 8,
})

/** The band's text after the %, as the mod's bandDetail draws it. */
const bandText = (w: typeof five) => {
  const left = w.hoursLeft ?? 0
  const lasts =
    w.verdict === 'exhausts' ? `acaba em ~${hours(left)}` : left >= (w.msToReset ?? 0) / HOUR ? 'dura até renovar' : `dura ~${hours(left)}`
  return `${lasts} · renova ${clockTime(w.resetsAt ?? NOW, NOW)}`
}
const fiveColor = five.verdict === 'ok' ? '#3fb950' : '#d29922'
const weekColor = week.verdict === 'exhausts' ? '#f85149' : week.verdict === 'tight' ? '#d29922' : '#3fb950'

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
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="244" viewBox="0 0 1000 244">`,
  `<rect width="1000" height="244" rx="10" fill="#0d1117"/>`,
  `<rect width="1000" height="32" rx="10" fill="#161b22"/><rect y="22" width="1000" height="10" fill="#161b22"/>`,
  `<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/><circle cx="60" cy="16" r="6" fill="#28c840"/>`,
  `<text x="500" y="21" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${DIM}">claude — my-game</text>`,
  line(66, [
    { text: '5h ', bold: true }, { text: '███░░░░░', color: fiveColor }, { text: ' 38% ', color: fiveColor, bold: true },
    { text: `${bandText(five)}   `, color: DIM },
    { text: 'Sem ', bold: true }, { text: '███░░░░░', color: weekColor }, { text: ' 41% ', color: weekColor, bold: true },
    { text: bandText(week), color: DIM },
  ]),
  line(90, [
    { text: `⚠ Semanal acaba ~${clockTime(week.exhaustAt ?? NOW, NOW)}, antes de renovar  `, color: R },
    { text: '[ Haiku nos subagentes ]', color: '#58a6ff', bold: true },
  ]),
  line(114, [
    { text: '3 sessões · 6.3M tokens · US$ 9,91 · API US$ 37/200 · /limites  ', color: DIM },
    { text: '↻  ▾', color: '#c9d1d9' },
  ]),
  `<line x1="24" y1="138" x2="976" y2="138" stroke="#30363d"/>`,
  line(162, [{ text: '❯ ', color: '#d2a8ff' }, { text: 'Implement the dodge window and run the EditMode tests', color: '#c9d1d9' }]),
  `<line x1="24" y1="180" x2="976" y2="180" stroke="#30363d"/>`,
  line(204, [
    { text: `  ${statusPart(five)} │ ${statusPart(week)} │ 3 sessões · 6.3M tok · US$ 9,91`, color: DIM },
  ]),
  line(224, [{ text: '  Unity · ✓ compila · EditMode 15/15 ✓', color: G }]),
  `</svg>`,
].join('\n')

// ---------- desktop pane ----------

const card = (y: number, h: number, border: string) =>
  `<rect x="20" y="${y}" width="640" height="${h}" rx="10" fill="#ffffff" stroke="${border}" stroke-width="1.5"/>`
const t = (x: number, y: number, text: string, opts: { size?: number; color?: string; bold?: boolean; anchor?: string } = {}) =>
  `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${opts.size ?? 13}" fill="${opts.color ?? '#1f2328'}"${opts.bold ? ' font-weight="600"' : ''}${opts.anchor ? ` text-anchor="${opts.anchor}"` : ''}>${esc(text)}</text>`
const stat = (x: number, y: number, label: string, value: string, color?: string) =>
  t(x, y, label, { size: 11, color: '#656d76' }) + t(x, y + 18, value, { bold: true, color })

/** "Dura" as the pane's card shows it. */
const lasts = (w: typeof five) =>
  w.verdict !== 'exhausts' && (w.hoursLeft ?? 0) >= (w.msToReset ?? 0) / HOUR ? 'até renovar' : `~${hours(w.hoursLeft ?? 0)}`
const renews = (w: typeof five) => `${clockTime(w.resetsAt ?? NOW, NOW)} · em ${duration(w.msToReset ?? 0)}`
const RED = '#e5484d'
const GREEN = '#2f9e62'
const limitCard = (x: number, w: typeof five, label: string, rate: string, rateLabel: string, verdict: string) => {
  const color = w.verdict === 'exhausts' ? RED : w.verdict === 'tight' ? '#d99a00' : GREEN
  return [
    `<rect x="${x}" y="50" width="314" height="168" rx="10" fill="#ffffff" stroke="${w.verdict === 'exhausts' ? RED : '#d0d7de'}" stroke-width="1.5"/>`,
    nest(limitRingSvg(w, NOW, 88), x + 14, 64),
    t(x + 116, 78, label, { bold: true }),
    stat(x + 116, 104, 'Dura', lasts(w), color),
    stat(x + 216, 104, rateLabel, rate),
    stat(x + 116, 144, 'Renova', renews(w)),
    t(x + 14, 186, verdict, { size: 12, color }),
  ].join('')
}
const row = (y: number, cells: [number, string, { color?: string; bold?: boolean; size?: number }?][]) =>
  cells.map(([x, text, o]) => t(x, y, text, { size: 12, ...o })).join('')

const desktop = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="520" viewBox="0 0 680 520">`,
  `<rect width="680" height="520" rx="12" fill="#f6f8fa"/>`,
  t(24, 34, 'Limites de uso', { size: 15, bold: true }),
  t(656, 34, 'atualizado 10:00  ↻ Atualizar', { size: 12, color: '#656d76', anchor: 'end' }),
  limitCard(20, five, '5 horas', `${Math.round(five.ratePerHour ?? 0)}%/h`, 'Ritmo recente', '✓ Dura até renovar'),
  limitCard(346, week, 'Semanal', `${Math.round((week.ratePerHour ?? 0) * 24)} pts/dia`, 'Ritmo da conta', `⚠ Acaba ~${clockTime(week.exhaustAt ?? NOW, NOW)}, antes de renovar`),
  `<rect x="20" y="232" width="640" height="150" rx="10" fill="#ffffff" stroke="#d99a00" stroke-width="1.5"/>`,
  t(36, 258, 'Qual modelo usar', { bold: true }),
  t(36, 280, 'Use Opus 5.5 para orquestrar e Haiku para executar: o plano dura até o reset.', { size: 12, color: '#9a6700' }),
  row(306, [[36, 'Se o resto da janela semanal seguir o gasto das últimas 3 horas com uso:', { color: '#656d76' }]]),
  row(326, [[36, '› Subagentes em Haiku', { bold: true }], [300, '~140h', { color: GREEN }], [390, '82% no reset', { color: '#656d76' }], [500, '−58% gasto', { color: '#656d76' }]]),
  row(346, [[36, '  Tudo em Sonnet'], [300, '~96h', { color: GREEN }], [390, '97% no reset', { color: '#656d76' }], [500, '−45% gasto', { color: '#656d76' }]]),
  `<rect x="36" y="356" width="150" height="20" rx="6" fill="#0969da"/>`,
  t(111, 370, 'Haiku nos subagentes', { size: 11, color: '#ffffff', bold: true, anchor: 'middle' }),
  `<rect x="20" y="396" width="640" height="110" rx="10" fill="#ffffff" stroke="#d0d7de" stroke-width="1.5"/>`,
  t(36, 420, 'Sessões', { bold: true }),
  ...[
    ['● my-game', 'Opus 5.5', '4.1M', 'US$ 6,42', 0.65],
    ['○ web-app', 'Sonnet 5.5', '1.6M', 'US$ 2,31', 0.23],
    ['○ claude-mods', 'Haiku 5.5', '0.6M', 'US$ 1,18', 0.12],
  ].map(([name, model, tok, cost, share], i) => {
    const y = 442 + i * 20
    return (
      row(y, [[36, String(name), { bold: i === 0 }], [190, String(model), { color: '#656d76' }], [290, String(tok), { color: '#656d76' }], [360, String(cost)]]) +
      nest(shareSvg(Number(share), 64, 8), 460, y - 8) +
      t(534, y, percent(Number(share) * 100), { size: 12, color: '#656d76' })
    )
  }),
  `</svg>`,
].join('\n')

writeFileSync(new URL('./terminal.svg', import.meta.url), terminal)
writeFileSync(new URL('./desktop-pane.svg', import.meta.url), desktop)
console.log('docs/terminal.svg and docs/desktop-pane.svg written')
