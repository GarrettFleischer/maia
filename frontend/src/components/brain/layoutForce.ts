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

const BOX_HEIGHT = 22
const CELL_X = 168
const CELL_Y = 48

export function labelSize(label: string): { w: number; h: number } {
  const chars = Math.max(label.trim().length, 1)
  return { w: Math.min(140, 7 * chars + 16), h: BOX_HEIGHT }
}

export function layoutLabeled(nodes: readonly LabeledNode[]): LabelBox[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  return nodes.map((node, index) => {
    const size = labelSize(node.label)
    const column = index % cols
    const row = Math.floor(index / cols)
    return {
      id: node.id,
      x: column * CELL_X,
      y: row * CELL_Y,
      w: size.w,
      h: size.h,
    }
  })
}

export function boxesOverlap(left: LabelBox, right: LabelBox): boolean {
  return (
    left.x < right.x + right.w &&
    right.x < left.x + left.w &&
    left.y < right.y + right.h &&
    right.y < left.y + left.h
  )
}
