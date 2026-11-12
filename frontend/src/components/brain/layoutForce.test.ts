import { describe, expect, it } from 'vitest'
import { boxesOverlap, layoutLabeled } from '@/components/brain/layoutForce'

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
      }
    }
  })
})
