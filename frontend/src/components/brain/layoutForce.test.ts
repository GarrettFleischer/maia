import { describe, expect, it } from 'vitest'
import {
  boxesOverlap,
  entityShortName,
  labelSize,
  layoutLabeled,
  wrapGraphText,
} from '@/components/brain/layoutForce'

describe('layoutLabeled', () => {
  it('places sixty labels with finite positions and no overlaps', () => {
    const nodes = Array.from({ length: 64 }, (_, index) => ({
      id: `n-${index}`,
      label: index % 2 === 0 ? `Place number ${index} with a long name` : `Node ${index}`,
    }))
    const boxes = layoutLabeled(nodes)
    expect(boxes).toHaveLength(64)
    for (const box of boxes) {
      expect(Number.isFinite(box.x)).toBe(true)
      expect(Number.isFinite(box.y)).toBe(true)
      expect(box.w).toBeGreaterThan(0)
      expect(box.h).toBeGreaterThan(0)
    }
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        expect(boxesOverlap(boxes[left]!, boxes[right]!)).toBe(false)
        expect(separated(boxes[left]!, boxes[right]!)).toBe(true)
      }
    }
  })

  it('wraps claim text on word boundaries and sizes the box to those lines', () => {
    const sentence = 'The user has a folder located at F:\\Development\\Ideas.'
    const lines = wrapGraphText(sentence)
    const shown = lines.join(' ')
    const words = sentence.split(/\s+/)
    const shownWords = shown.split(/\s+/)
    expect(shownWords.length).toBeGreaterThan(0)
    expect(words.slice(0, shownWords.length)).toEqual(shownWords)
    expect(shown).toContain('folder')
    expect(shown).not.toContain('fol ')
    expect(lines.some((line) => line === 'fol' || line.endsWith(' fol'))).toBe(false)
    const size = labelSize(sentence)
    const box = layoutLabeled([{ id: 'folder', label: sentence }])[0]
    expect(box?.w).toBe(size.w)
    expect(box?.h).toBe(size.h)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(size.h).toBeGreaterThan(22)
  })

  it('uses the short entity name for people, places, and folders', () => {
    expect(entityShortName('Owner', 'person')).toBe('Owner')
    expect(entityShortName('Canby Oregon', 'person')).toBe('Canby')
    expect(entityShortName('Canby, Oregon', 'place')).toBe('Canby')
    expect(entityShortName('Canby', 'place')).toBe('Canby')
    expect(entityShortName('F:\\Development\\Ideas', 'path')).toBe('Ideas folder')
  })

  it('keeps long visible labels from overlapping', () => {
    const nodes = [
      { id: 'owner', label: 'Owner' },
      { id: 'canby', label: 'Canby' },
      { id: 'ideas', label: 'Ideas folder' },
      { id: 'name', label: "The user's name is Garrett." },
      { id: 'home', label: 'The user lives in Canby, Oregon.' },
      { id: 'folder', label: 'The user has a folder located at F:\\Development\\Ideas.' },
    ]
    const boxes = layoutLabeled(nodes)
    for (const [index, node] of nodes.entries()) {
      const size = labelSize(node.label)
      expect(boxes[index]?.w).toBe(size.w)
      expect(boxes[index]?.h).toBe(size.h)
    }
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        expect(boxesOverlap(boxes[left]!, boxes[right]!)).toBe(false)
        expect(separated(boxes[left]!, boxes[right]!)).toBe(true)
      }
    }
  })

  it('fits name, place, and folder labels inside a phone-width row', () => {
    const nodes = [
      { id: 'folder', label: 'The user has a folder located at F:\\Development\\Ideas.' },
      { id: 'name', label: "The user's name is Garrett." },
      { id: 'home', label: 'The user lives in Canby, Oregon.' },
      { id: 'canby', label: 'Canby' },
      { id: 'ideas', label: 'Ideas folder' },
      { id: 'owner', label: 'Owner' },
    ]
    const boxes = layoutLabeled(nodes, 368)
    const right = Math.max(...boxes.map((box) => box.x + box.w))
    expect(right).toBeLessThanOrEqual(368)
    for (let left = 0; left < boxes.length; left += 1) {
      for (let rightIndex = left + 1; rightIndex < boxes.length; rightIndex += 1) {
        expect(boxesOverlap(boxes[left]!, boxes[rightIndex]!)).toBe(false)
      }
    }
  })
})

function separated(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
): boolean {
  const gapX = Math.max(left.x, right.x) - Math.min(left.x + left.w, right.x + right.w)
  const gapY = Math.max(left.y, right.y) - Math.min(left.y + left.h, right.y + right.h)
  return gapX >= 8 || gapY >= 8
}
