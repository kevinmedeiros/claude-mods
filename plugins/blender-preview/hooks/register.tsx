import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Budgets, GlbCheck } from '../types'
import { STATS_CODE, exportPath, fromBase64, glbText, parseGlb, parseStats, warnings } from './glb'

const PANE = 'blender-preview'
const PREFIX = 'mcp__Blender__'
/** Ferramentas do Blender MCP que só leem ou renderizam: não mudam a cena. */
const READ_ONLY = /^(get_|render_|search_|jump_)/

const preview = atom({ plugin: 'blender-preview', key: 'preview' } as const, null)
const glb = atom({ plugin: 'blender-preview', key: 'glb' } as const, null)
const busy = atom({ plugin: 'blender-preview', key: 'busy' } as const, false)

const live = { server: 'Blender', budgets: { maxTriangles: 20_000, maxBones: 100, maxTextureSize: 2048 } as Budgets, auto: true }

const textOf = (content: { type: string; text?: string }[]) =>
  content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n')

const tempFile = async ($: EngineInterface) => {
  const dir = (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? '/tmp'
  return `${dir.replaceAll('\\', '/').replace(/\/+$/, '')}/claude-blender-preview.png`
}

/** Mede a cena e renderiza a miniatura pelo Blender MCP. */
const refresh = async ($: EngineInterface) => {
  if (await read($, busy)) return
  await update($, busy, () => true)
  const at = await $.clock.now()
  try {
    const statsResult = await $.mcp.call(live.server, 'execute_blender_code', { code: STATS_CODE })
    const stats = statsResult.isError ? undefined : parseStats(textOf(statsResult.content))
    const file = await tempFile($)
    let png: string | undefined
    const thumb = await $.mcp.call(live.server, 'render_thumbnail_to_path', { output_path: file })
    if (!thumb.isError && (await $.fs.exists(file))) {
      const { base64 } = await $.fs.read(file, { as: 'bytes' })
      png = base64
    }
    await update($, preview, () => ({
      png,
      stats,
      at,
      problem: stats || png ? undefined : `O Blender respondeu com erro: ${textOf(statsResult.content).slice(0, 200)}`,
    }))
  } catch (error) {
    await update($, preview, () => ({
      at,
      problem: `Blender MCP indisponível (o Blender está aberto com o add-on conectado?): ${String(error).slice(0, 160)}`,
    }))
  } finally {
    await update($, busy, () => false)
  }
}

/** Lê um .glb do disco e confere contra os orçamentos. */
const inspectGlb = async ($: EngineInterface, path: string): Promise<GlbCheck> => {
  const at = await $.clock.now()
  let check: GlbCheck
  try {
    const stat = await $.fs.stat(path)
    if (stat.size > 4 * 1024 * 1024) {
      check = { path, at, problem: `${(stat.size / 1_048_576).toFixed(1)} MB: grande demais para ler aqui (limite de 4 MB).` }
    } else {
      const { base64 } = await $.fs.read(path, { as: 'bytes' })
      const report = parseGlb(fromBase64(base64), stat.size)
      check = report ? { path, at, report } : { path, at, problem: 'O arquivo não é um .glb válido.' }
    }
  } catch (error) {
    check = { path, at, problem: `Não consegui ler: ${String(error).slice(0, 160)}` }
  }
  await update($, glb, () => check)

  return check
}

const checkText = (c: GlbCheck) => (c.report ? glbText(c.path, c.report, live.budgets) : `Export GLB ${c.path}: ${c.problem}`)

export const register: Register = (on, options) => {
  live.server = String(options.server ?? 'Blender')
  live.auto = options.autoPreview !== false
  live.budgets = {
    maxTriangles: Number(options.maxTriangles ?? 20_000),
    maxBones: Number(options.maxBones ?? 100),
    maxTextureSize: Number(options.maxTextureSize ?? 2048),
  }
  let pending: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'blender', description: 'Prévia do Blender: miniatura da cena, triângulos, ossos e texturas' })
    await $.command.register({ name: 'glb', description: 'Confere um .glb contra os orçamentos do jogo', argumentHint: '<caminho.glb>' })

    return started
  })

  // Depois de cada mudança na cena pelo Blender MCP: atualiza a prévia e confere o GLB exportado.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!e.tool.startsWith(PREFIX) || ran.deny !== undefined || ran.isError) return ran
    const name = e.tool.slice(PREFIX.length)
    if (READ_ONLY.test(name)) return ran

    if (live.auto) {
      pending?.cancel()
      pending = $.clock.after(1500, () => void refresh($))
    }
    const code = (e as unknown as { code?: unknown }).code
    const path = typeof code === 'string' ? exportPath(code) : undefined
    if (!path) return ran
    const check = await inspectGlb($, path)

    return { ...ran, context: [...(ran.context ?? []), checkText(check)] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'blender' }, async $ => {
    void refresh($)
    await $.ui.open({ id: PANE, title: 'Blender' })
    return { text: 'Prévia do Blender aberta.' }
  })

  on('command.run', { command: 'glb' }, async ($, e) => {
    const path = e.args.trim().replace(/^["']|["']$/g, '')
    if (!path) return { text: 'Uso: /glb <caminho do arquivo .glb>' }
    const check = await inspectGlb($, path)
    await $.ui.open({ id: PANE, title: 'Blender' })
    return { text: checkText(check) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, preview)
    const g = await read($, glb)
    const isBusy = await read($, busy)
    const width = Math.max(20, Math.min(70, (e.props.bodyColumns ?? 60) - 2))
    const statsWarnings = p?.stats ? warnings(p.stats, live.budgets) : []

    const image = (() => {
      if (!p?.png) return undefined
      if (e.surface === 'terminal') {
        const { Image } = $.ui.resolve(e)
        return <Image key="thumb" source={{ png: p.png }} columns={width} rows={Math.round(width / 2.4)} alt="Miniatura da cena do Blender" />
      }
      if (e.surface === 'desktop' && p.png.length < 120_000) {
        const { Svg } = $.ui.resolve(e)
        const px = width * 7
        const source =
          `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${px} ${Math.round(px * 0.56)}" width="${px}" height="${Math.round(px * 0.56)}">` +
          `<image width="100%" height="100%" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${p.png}" xlink:href="data:image/png;base64,${p.png}"/></svg>`
        return <Svg key="thumb" source={source} alt="Miniatura da cena do Blender" width={px} height={Math.round(px * 0.56)} />
      }
      return undefined
    })()

    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" rowGap={1}>
        {isBusy && <Text color="warning">Atualizando pelo Blender…</Text>}
        {p?.problem && <Text color="error">{p.problem}</Text>}
        {!p && !isBusy && <Text dimColor>Sem prévia ainda. Abra o Blender com o add-on MCP e clique em Atualizar.</Text>}
        {image}
        {p?.stats && (
          <Box flexDirection="column">
            <Text bold>
              Cena: {p.stats.triangles.toLocaleString('pt-BR')} triângulos · {p.stats.bones} ossos · {p.stats.materials} materiais ·{' '}
              {p.stats.actions.length} animações
            </Text>
            {p.stats.objects.slice(0, 5).map(o => (
              <Text key={o.name} dimColor>
                {'  '}
                {o.name}: {o.triangles.toLocaleString('pt-BR')} tris
              </Text>
            ))}
            {statsWarnings.map(w => (
              <Text key={w} color="warning">
                ⚠ {w}
              </Text>
            ))}
            {statsWarnings.length === 0 && (
              <Text color="success">
                ✓ Dentro do orçamento ({live.budgets.maxTriangles.toLocaleString('pt-BR')} tris, {live.budgets.maxBones} ossos, texturas até{' '}
                {live.budgets.maxTextureSize})
              </Text>
            )}
          </Box>
        )}
        {g && (
          <Box flexDirection="column">
            <Text bold>Último GLB</Text>
            {checkText(g)
              .split('\n')
              .map((line, i) => (
                <Text key={`g${i}`} color={line.startsWith('⚠') ? 'warning' : undefined} dimColor={!line.startsWith('⚠')}>
                  {line}
                </Text>
              ))}
          </Box>
        )}
        <Box flexDirection="row" columnGap={2}>
          <Button key="refresh" label="Atualizar" onPress={() => void refresh($)} />
          {statsWarnings.length > 0 && (
            <Button
              key="send"
              label="Mandar avisos pro Claude"
              variant="primary"
              onPress={() =>
                void $.prompt.fill({ text: `A cena do Blender está fora do orçamento do jogo:\n${statsWarnings.map(w => `- ${w}`).join('\n')}` })
              }
            />
          )}
        </Box>
      </Box>
    )
  })
}
