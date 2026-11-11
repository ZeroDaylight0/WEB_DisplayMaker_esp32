import type { CanvasElement, DisplayKind, Project } from './types'

// Screen renders: the screen is drawn pixel by pixel the way a microcontroller
// would draw it (1-bit glyph edges, 1 px lines), scaled up without smoothing and
// optionally placed in a device bezel. Used by the "Render" dialog.

export interface RenderOptions {
  /** Pixel scale; 0 picks one so the longest side is about 640 px. */
  scale: number
  bezel: boolean
}

export interface ScreenState {
  label: string
  selection: Record<string, number>
}

interface Rgb { r: number; g: number; b: number }

const OLED_ON: Rgb = { r: 238, g: 246, b: 255 }
const OLED_OFF: Rgb = { r: 8, g: 10, b: 14 }
const PAPER: Rgb = { r: 238, g: 234, b: 224 }
const INK: Rgb = { r: 27, g: 27, b: 27 }
const MAX_STATES = 24

export function isElementVisible(element: CanvasElement, selection: Record<string, number> | undefined) {
  return (element.sourceBranchPath ?? []).every(({ id, choice }) => (selection?.[id] ?? 0) === choice)
}

function stateLabel(groupLabel: string, choice: string) {
  const label = choice === 'else' ? `else of ${groupLabel}`
    : choice === 'otherwise (code after it)' ? `after ${groupLabel}`
      : choice === 'no condition matched' ? `none of ${groupLabel}`
        : choice
  return label.length > 56 ? `${label.slice(0, 55)}…` : label
}

/**
 * Every distinct screen the imported source can show: the current selection plus
 * one state per branch choice (pages, if/else branches), without duplicates.
 */
export function screenStates(project: Pick<Project, 'elements' | 'sourceBranchGroups' | 'sourceBranchSelection'>): ScreenState[] {
  const groups = project.sourceBranchGroups ?? []
  const base = project.sourceBranchSelection ?? {}
  const states: ScreenState[] = []
  const seen = new Set<string>()
  const pageGroup = groups.find((group) => group.label === 'Display page')
  const add = (label: string, selection: Record<string, number>) => {
    const visible = project.elements.filter((element) => isElementVisible(element, selection)).map((element) => element.id)
    const key = visible.join('|')
    if (!visible.length || seen.has(key) || states.length >= MAX_STATES) return
    seen.add(key)
    states.push({ label, selection })
  }
  add(groups.length ? 'Current state' : 'Screen', base)
  for (const group of groups) {
    group.choices.forEach((choice, index) => {
      const selection = { ...base }
      group.parentPath?.forEach(({ id, choice: parentChoice }) => { selection[id] = parentChoice })
      selection[group.id] = index
      const page = pageGroup && group !== pageGroup ? pageGroup.choices[selection[pageGroup.id] ?? 0] : undefined
      const label = group === pageGroup ? choice : stateLabel(group.label, choice)
      add(page ? `${page} · ${label}` : label, selection)
    })
  }
  return states
}

export function autoScale(width: number, height: number) {
  return Math.max(1, Math.min(4, Math.floor(640 / Math.max(width, height))))
}

function parseColor(value: string): Rgb | undefined {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) return undefined
  const full = hex.length === 3 ? [...hex].map((part) => part + part).join('') : hex
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement | undefined>((resolve) => {
    const image = new window.Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(undefined)
    image.src = source
  })
}

function canvas(width: number, height: number) {
  const element = document.createElement('canvas')
  element.width = Math.max(1, Math.round(width))
  element.height = Math.max(1, Math.round(height))
  const context = element.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser does not support canvas rendering')
  return { element, context }
}

function plotLine(context: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  let x = Math.round(x0)
  let y = Math.round(y0)
  const xEnd = Math.round(x1)
  const yEnd = Math.round(y1)
  if (y === yEnd) { context.fillRect(Math.min(x, xEnd), y, Math.abs(xEnd - x) || 1, 1); return }
  if (x === xEnd) { context.fillRect(x, Math.min(y, yEnd), 1, Math.abs(yEnd - y) || 1); return }
  const dx = Math.abs(xEnd - x)
  const dy = -Math.abs(yEnd - y)
  const sx = x < xEnd ? 1 : -1
  const sy = y < yEnd ? 1 : -1
  let error = dx + dy
  for (let guard = 0; guard < 8192; guard += 1) {
    context.fillRect(x, y, 1, 1)
    if (x === xEnd && y === yEnd) break
    const doubled = 2 * error
    if (doubled >= dy) { error += dy; x += sx }
    if (doubled <= dx) { error += dx; y += sy }
  }
}

const canvasAlign: Record<NonNullable<CanvasElement['textAnchor']>, CanvasTextAlign> = { start: 'left', middle: 'center', end: 'right' }
const canvasBaseline: Record<NonNullable<CanvasElement['textBaseline']>, CanvasTextBaseline> = {
  hanging: 'hanging', central: 'middle', 'text-after-edge': 'bottom', alphabetic: 'alphabetic',
}

function drawElement(context: CanvasRenderingContext2D, element: CanvasElement, images: Map<string, HTMLImageElement>) {
  const fill = element.fill !== 'none' ? element.fill : undefined
  const stroke = element.stroke !== 'none' ? element.stroke : undefined
  const x = Math.round(element.x)
  const y = Math.round(element.y)
  const width = Math.round(element.width)
  const height = Math.round(element.height)
  if (element.kind === 'rect') {
    context.beginPath()
    if (element.radius > 0) context.roundRect(x + .5, y + .5, Math.max(0, width - 1), Math.max(0, height - 1), element.radius)
    else context.rect(x + .5, y + .5, Math.max(0, width - 1), Math.max(0, height - 1))
    if (fill) {
      context.fillStyle = fill
      if (element.radius > 0) context.fill()
      else context.fillRect(x, y, width, height)
    }
    if (stroke && (!fill || stroke !== fill)) {
      context.strokeStyle = stroke
      context.lineWidth = 1
      context.stroke()
    }
  } else if (element.kind === 'circle') {
    context.beginPath()
    context.ellipse(element.x + element.width / 2, element.y + element.height / 2, Math.max(.5, element.width / 2 - .5), Math.max(.5, element.height / 2 - .5), 0, 0, Math.PI * 2)
    if (fill) { context.fillStyle = fill; context.fill() }
    if (stroke && (!fill || stroke !== fill)) { context.strokeStyle = stroke; context.lineWidth = 1; context.stroke() }
  } else if (element.kind === 'line') {
    context.fillStyle = stroke ?? fill ?? '#ffffff'
    for (const offset of element.repeatOffsets ?? [0]) {
      const dx = element.repeatAxis === 'x' ? offset : 0
      const dy = element.repeatAxis === 'y' ? offset : 0
      plotLine(context, element.x + dx, element.y + dy, element.x + element.width + dx, element.y + element.height + dy)
    }
  } else if (element.kind === 'image' && element.imageData) {
    const image = images.get(element.imageData)
    if (image) context.drawImage(image, x, y, width, height)
  } else if (element.kind === 'text' && element.text) {
    context.fillStyle = fill ?? '#ffffff'
    context.font = `${element.fontWeight} ${element.fontSize}px ${element.fontFamily}`
    context.textAlign = canvasAlign[element.textAnchor ?? 'start']
    context.textBaseline = element.textBaseline ? canvasBaseline[element.textBaseline] : 'alphabetic'
    context.fillText(element.text, element.x, element.textBaseline ? element.y : element.y + element.fontSize)
  }
}

/** Draws the visible elements at native resolution with hard (1-bit) edges. */
export async function renderScreen(project: Project, kind: DisplayKind, selection = project.sourceBranchSelection) {
  const { width, height } = project
  const visible = project.elements.filter((element) => isElementVisible(element, selection))
  const images = new Map<string, HTMLImageElement>()
  await Promise.all([...new Set(visible.flatMap((element) => element.kind === 'image' && element.imageData ? [element.imageData] : []))]
    .map(async (source) => {
      const image = await loadImage(source)
      if (image) images.set(source, image)
    }))
  const screen = canvas(width, height)
  const paper = kind === 'E-Paper'
  screen.context.fillStyle = paper ? '#eeeae0' : '#000000'
  screen.context.fillRect(0, 0, width, height)
  const layer = canvas(width, height)
  for (const element of visible) {
    layer.context.clearRect(0, 0, width, height)
    layer.context.save()
    drawElement(layer.context, element, images)
    layer.context.restore()
    // Snap antialiased edges to whole pixels, like 1 bpp fonts on the device.
    const pixels = layer.context.getImageData(0, 0, width, height)
    const data = pixels.data
    const solid = element.kind !== 'image' ? parseColor(element.kind === 'line' ? element.stroke : element.fill === 'none' ? element.stroke : element.fill) : undefined
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] < 128) { data[index + 3] = 0; continue }
      if (solid) {
        data[index] = solid.r; data[index + 1] = solid.g; data[index + 2] = solid.b
      } else if (data[index + 3] < 255) {
        const alpha = data[index + 3] / 255
        data[index] = Math.round(data[index] / alpha); data[index + 1] = Math.round(data[index + 1] / alpha); data[index + 2] = Math.round(data[index + 2] / alpha)
      }
      data[index + 3] = 255
    }
    layer.context.putImageData(pixels, 0, 0)
    screen.context.drawImage(layer.element, 0, 0)
  }
  if (!project.color) {
    const pixels = screen.context.getImageData(0, 0, width, height)
    const data = pixels.data
    for (let index = 0; index < data.length; index += 4) {
      const luminance = data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114
      const on = paper ? luminance < 128 : luminance > 24
      const color = paper ? on ? INK : PAPER : on ? OLED_ON : OLED_OFF
      data[index] = color.r; data[index + 1] = color.g; data[index + 2] = color.b; data[index + 3] = 255
    }
    screen.context.putImageData(pixels, 0, 0)
  }
  return screen.element
}

/** Scales the native screen with nearest-neighbour sampling and adds the bezel. */
export function frameScreen(screen: HTMLCanvasElement, options: RenderOptions) {
  const scale = options.scale || autoScale(screen.width, screen.height)
  const scaledWidth = screen.width * scale
  const scaledHeight = screen.height * scale
  const pad = options.bezel ? 18 : 0
  const output = canvas(scaledWidth + pad * 2, scaledHeight + pad * 2)
  const context = output.context
  if (options.bezel) {
    context.beginPath()
    context.roundRect(1, 1, output.element.width - 2, output.element.height - 2, 16)
    context.fillStyle = '#1c1e24'
    context.fill()
    context.strokeStyle = '#3c4048'
    context.lineWidth = 2
    context.stroke()
    context.fillStyle = '#000000'
    context.fillRect(pad - 3, pad - 3, scaledWidth + 6, scaledHeight + 6)
  }
  context.imageSmoothingEnabled = false
  context.drawImage(screen, pad, pad, scaledWidth, scaledHeight)
  return output.element
}

export async function renderFramed(project: Project, kind: DisplayKind, options: RenderOptions, selection = project.sourceBranchSelection) {
  return frameScreen(await renderScreen(project, kind, selection), options)
}

/** A contact sheet with every screen state of the project, labelled. */
export async function renderSheet(project: Project, kind: DisplayKind, displayName: string, options: RenderOptions) {
  const states = screenStates(project)
  const tiles = await Promise.all(states.map((state) => renderFramed(project, kind, options, state.selection)))
  const tileWidth = Math.max(...tiles.map((tile) => tile.width))
  const tileHeight = Math.max(...tiles.map((tile) => tile.height))
  const columns = Math.max(1, Math.min(tiles.length, Math.floor(1600 / (tileWidth + 24)) || 1, Math.ceil(Math.sqrt(tiles.length * 1.6))))
  const rows = Math.ceil(tiles.length / columns)
  const gap = 24
  const labelHeight = 30
  const header = 64
  const sheet = canvas(columns * tileWidth + (columns + 1) * gap, header + rows * (tileHeight + labelHeight + gap) + gap / 2)
  const context = sheet.context
  context.fillStyle = '#121418'
  context.fillRect(0, 0, sheet.element.width, sheet.element.height)
  context.textBaseline = 'alphabetic'
  context.fillStyle = '#e8eaed'
  context.font = '600 20px system-ui, -apple-system, "Segoe UI", sans-serif'
  context.fillText(project.name, gap, 38)
  context.fillStyle = '#8a8f98'
  context.font = '13px system-ui, -apple-system, "Segoe UI", sans-serif'
  context.fillText(`${displayName} · ${project.width} × ${project.height} px · ${states.length} state${states.length === 1 ? '' : 's'}`, gap, 56)
  tiles.forEach((tile, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = gap + column * (tileWidth + gap)
    const y = header + row * (tileHeight + labelHeight + gap)
    context.drawImage(tile, x + Math.round((tileWidth - tile.width) / 2), y)
    context.fillStyle = '#b7bbc2'
    context.font = '12px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace'
    context.textAlign = 'center'
    let label = states[index].label
    while (label.length > 4 && context.measureText(label).width > tileWidth) label = `${label.slice(0, -2)}…`
    context.fillText(label, x + tileWidth / 2, y + tileHeight + 20)
    context.textAlign = 'left'
  })
  return { canvas: sheet.element, count: states.length }
}

export function canvasToBlob(source: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => source.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Failed to render PNG')), 'image/png'))
}
