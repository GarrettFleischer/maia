import { describe, expect, it } from 'vitest'
import {
  layoutBrainMap,
  parseBrainMap,
  validateFactSentence,
  visibleBrainNodes,
  type BrainEdge,
  type BrainFilter,
  type BrainMap,
  type BrainNode,
} from '@/components/brain/layoutBrainMap'

function node(overrides: Partial<BrainNode> & Pick<BrainNode, 'id' | 'kind' | 'label'>): BrainNode {
  return {
    sentence: overrides.label,
    taint: 'trusted',
    session_id: 'thread-1',
    held: false,
    ...overrides,
  }
}

const edges: BrainEdge[] = [
  {
    kind: 'mention',
    from_kind: 'fact',
    from_id: 'fact-a',
    to_kind: 'episode',
    to_id: 'episode-1',
  },
  {
    kind: 'lexeme',
    from_kind: 'fact',
    from_id: 'fact-a',
    to_kind: 'lexeme',
    to_id: 'alpha',
  },
]

const map: BrainMap = {
  nodes: [
    node({ id: 'fact-a', kind: 'fact', label: 'Alpha stays.', sentence: 'Alpha stays.' }),
    node({
      id: 'fact-b',
      kind: 'fact',
      label: 'Beta stays.',
      sentence: 'Beta stays.',
      session_id: 'thread-2',
    }),
    node({
      id: 'episode-1',
      kind: 'episode',
      label: 'Alpha exchange',
      sentence: 'Alpha exchange',
    }),
    node({
      id: 'alpha',
      kind: 'lexeme',
      label: 'alpha',
      sentence: null,
      taint: null,
      session_id: null,
    }),
  ],
  edges,
}

const allKinds: BrainFilter['kinds'] = new Set(['fact', 'claim', 'episode', 'lexeme'])

describe('layoutBrainMap', () => {
  it('places every node and repeats the same layout', () => {
    const size = { width: 800, height: 600 }
    const first = layoutBrainMap(map.nodes, map.edges, size)
    const second = layoutBrainMap(map.nodes, map.edges, size)
    expect([...first.keys()].sort()).toEqual(['alpha', 'episode-1', 'fact-a', 'fact-b'])
    expect(first).toEqual(second)
    for (const point of first.values()) {
      expect(Number.isFinite(point.x)).toBe(true)
      expect(Number.isFinite(point.y)).toBe(true)
    }
    const alpha = first.get('alpha')
    const factA = first.get('fact-a')
    const factB = first.get('fact-b')
    expect(alpha).toBeDefined()
    expect(factA).toBeDefined()
    expect(factB).toBeDefined()
    expect(alpha!.x).toBeGreaterThan(factA!.x)
    expect(factB!.x).toBeGreaterThan(factA!.x)
  })
})

describe('visibleBrainNodes', () => {
  it('keeps nodes whose text matches the query', () => {
    const visible = visibleBrainNodes(map, { query: 'alpha', kinds: allKinds, sessionId: null })
    expect(visible.map((item) => item.id).sort()).toEqual(['alpha', 'episode-1', 'fact-a'])
  })
})

describe('validateFactSentence', () => {
  it('accepts one line and rejects a blank or a break', () => {
    expect(validateFactSentence('Notes stay on this computer.')).toBeNull()
    expect(validateFactSentence('  ')).toBe('Enter one sentence.')
    expect(validateFactSentence('two\nlines')).toBe('Enter one sentence.')
  })
})

describe('parseBrainMap', () => {
  it('reads a map and rejects a body that is not a graph', () => {
    expect(parseBrainMap({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], tags: [] })
    expect(() => parseBrainMap({ nodes: [] })).toThrow(/could not be read/)
  })
})
