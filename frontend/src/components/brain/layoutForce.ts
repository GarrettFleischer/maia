/** Label-aware placement. Boxes never share pixels. */

export interface LabeledNode {
  id: string
  label: string
}

export interface LabelBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export const GRAPH_LINE_CHARS = 22
export const GRAPH_MAX_LINES = 3
export const GRAPH_LINE_HEIGHT = 16
export const GRAPH_CHAR_W = 8
export const GRAPH_PAD_X = 16
export const GRAPH_PAD_Y = 10
const GRAPH_GAP = 12

const US_STATES = new Set([
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'wisconsin',
  'wyoming',
])

export function wrapGraphText(
  label: string,
  maxChars = GRAPH_LINE_CHARS,
  maxLines = GRAPH_MAX_LINES,
): string[] {
  const words = label.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let line: string[] = []
  let length = 0
  for (const word of words) {
    const nextLength = line.length === 0 ? word.length : length + 1 + word.length
    if (line.length > 0 && nextLength > maxChars) {
      lines.push(line.join(' '))
      if (lines.length === maxLines) return lines
      line = [word]
      length = word.length
      continue
    }
    line.push(word)
    length = nextLength
  }
  if (line.length > 0 && lines.length < maxLines) lines.push(line.join(' '))
  return lines
}

export function entityShortName(label: string, kind: string | null): string {
  if (kind === 'path' || looksLikePath(label)) return pathShortName(label)
  return cityFromPlace(label) ?? label
}

export function graphDisplayLabel(node: {
  kind: string
  label: string
  entity_kind?: string | null
}): string {
  if (node.kind !== 'entity') return node.label
  return entityShortName(node.label, node.entity_kind ?? null)
}

export function labelSize(label: string): { w: number; h: number } {
  const lines = wrapGraphText(label)
  const widest = lines.reduce((max, line) => Math.max(max, line.length), 1)
  return {
    w: GRAPH_CHAR_W * widest + GRAPH_PAD_X,
    h: GRAPH_LINE_HEIGHT * lines.length + GRAPH_PAD_Y,
  }
}

export function layoutLabeled(nodes: readonly LabeledNode[], maxRowWidth?: number): LabelBox[] {
  if (nodes.length === 0) return []
  const sized = nodes.map((node) => ({ id: node.id, ...labelSize(node.label) }))
  const cols = columnsFor(
    sized.map((box) => box.w),
    maxRowWidth,
  )
  const colWidths = Array.from({ length: cols }, () => 0)
  const rowHeights: number[] = []
  sized.forEach((box, index) => {
    const column = index % cols
    const row = Math.floor(index / cols)
    colWidths[column] = Math.max(colWidths[column] ?? 0, box.w)
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, box.h)
  })
  const colX: number[] = []
  let cursorX = 0
  for (const width of colWidths) {
    colX.push(cursorX)
    cursorX += width + GRAPH_GAP
  }
  const rowY: number[] = []
  let cursorY = 0
  for (const height of rowHeights) {
    rowY.push(cursorY)
    cursorY += height + GRAPH_GAP
  }
  return sized.map((box, index) => {
    const column = index % cols
    const row = Math.floor(index / cols)
    return {
      id: box.id,
      x: colX[column] ?? 0,
      y: rowY[row] ?? 0,
      w: box.w,
      h: box.h,
    }
  })
}

function columnsFor(widths: readonly number[], maxRowWidth: number | undefined): number {
  const count = widths.length
  if (maxRowWidth === undefined) return Math.max(1, Math.ceil(Math.sqrt(count)))
  let chosen = 1
  for (let cols = 1; cols <= count; cols += 1) {
    if (packedWidth(widths, cols) <= maxRowWidth) chosen = cols
  }
  return chosen
}

function packedWidth(widths: readonly number[], cols: number): number {
  const colWidths = Array.from({ length: cols }, () => 0)
  widths.forEach((width, index) => {
    const column = index % cols
    colWidths[column] = Math.max(colWidths[column] ?? 0, width)
  })
  return colWidths.reduce((sum, width) => sum + width, 0) + GRAPH_GAP * (cols - 1)
}

export function boxesOverlap(left: LabelBox, right: LabelBox): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  )
}

function looksLikePath(label: string): boolean {
  return label.includes('\\') || label.includes('/') || label.includes('://')
}

function pathShortName(label: string): string {
  const trimmed = label.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0)
  const last = parts[parts.length - 1] ?? label
  if (/\.[A-Za-z0-9]{1,8}$/.test(last)) return last
  return `${last} folder`
}

function cityFromPlace(label: string): string | null {
  const words = label
    .split(/[\s,]+/)
    .map((word) => word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''))
    .filter((word) => word.length > 0)
  const state = words[1]
  if (words.length === 2 && state && US_STATES.has(state.toLowerCase())) return words[0] ?? null
  return null
}
