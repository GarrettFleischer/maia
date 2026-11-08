import { describe, expect, it } from 'vitest'
import type { BrainMap } from '@/components/brain/layoutBrainMap'
import { inspectorBrainHasFactOrEpisode, inspectorBrainMap } from '@/components/inspector/inspectorBrain'

const map: BrainMap = {
  nodes: [
    {
      id: 'episode-router',
      kind: 'episode',
      label: 'Router exchange',
      sentence: null,
      taint: 'trusted',
      session_id: 'router',
      held: false,
    },
    {
      id: 'episode-other',
      kind: 'episode',
      label: 'Other thread',
      sentence: null,
      taint: 'trusted',
      session_id: 'thread-1',
      held: false,
    },
    {
      id: 'claim-1',
      kind: 'claim',
      label: 'Obsidian opens the vault.',
      sentence: 'Obsidian opens the vault.',
      taint: 'untrusted',
      session_id: 'thread-1',
      held: false,
    },
    {
      id: 'fact-other',
      kind: 'fact',
      label: 'Tailscale serves the desk.',
      sentence: 'Tailscale serves the desk.',
      taint: 'trusted',
      session_id: null,
      held: false,
    },
    {
      id: 'obsidian',
      kind: 'lexeme',
      label: 'obsidian',
      sentence: null,
      taint: null,
      session_id: null,
      held: false,
    },
  ],
  edges: [
    {
      kind: 'lexeme',
      from_kind: 'claim',
      from_id: 'claim-1',
      to_kind: 'lexeme',
      to_id: 'obsidian',
    },
    {
      kind: 'lexeme',
      from_kind: 'fact',
      from_id: 'fact-other',
      to_kind: 'lexeme',
      to_id: 'obsidian',
    },
  ],
}

describe('inspectorBrainMap', () => {
  it('keeps the router episode, the recalled claim, and a lexeme that touches it', () => {
    const filtered = inspectorBrainMap(map, new Set(['claim-1']))
    expect(filtered.nodes.map((node) => node.id).sort()).toEqual([
      'claim-1',
      'episode-router',
      'obsidian',
    ])
    expect(filtered.edges).toHaveLength(1)
    expect(filtered.edges[0]?.from_id).toBe('claim-1')
    expect(inspectorBrainHasFactOrEpisode(filtered)).toBe(true)
  })

  it('has neither a fact nor an episode when the router thread and recall are empty', () => {
    const unrelated: BrainMap = {
      nodes: map.nodes.filter((node) => node.id === 'fact-other'),
      edges: [],
    }
    const filtered = inspectorBrainMap(unrelated, new Set())
    expect(filtered.nodes).toEqual([])
    expect(inspectorBrainHasFactOrEpisode(filtered)).toBe(false)
  })
})
