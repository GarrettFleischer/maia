import { describe, expect, it } from 'vitest'
import type { BrainNode, BrainSearchHit } from '@/components/brain/layoutBrainMap'
import { groupFactsByPrimaryTag, orderSearchHits, type MemoryTag } from '@/components/brain/memoryTags'

const catalog: MemoryTag[] = [
  { id: 'tag-people', name: 'People', role: 'people' },
  { id: 'tag-places', name: 'Places', role: 'places' },
  { id: 'tag-things', name: 'Things', role: 'things' },
  { id: 'tag-ideas', name: 'Ideas', role: 'ideas' },
]

function fact(id: string, tags: string[]): BrainNode {
  return {
    id,
    kind: 'claim',
    label: id,
    sentence: id,
    taint: 'trusted',
    session_id: null,
    held: false,
    tags,
  }
}

describe('groupFactsByPrimaryTag', () => {
  it('groups by the first tag and hides empty default tags', () => {
    const groups = groupFactsByPrimaryTag(
      [fact('city', ['Places']), fact('name', ['People', 'Ideas']), fact('path', ['Things'])],
      catalog,
    )
    expect(groups.map((group) => group.title)).toEqual(['People', 'Places', 'Things'])
    expect(groups[0]?.nodes.map((node) => node.id)).toEqual(['name'])
    expect(groups.find((group) => group.title === 'Ideas')).toBeUndefined()
  })

  it('keeps a fact that has no tag instead of dropping it', () => {
    const groups = groupFactsByPrimaryTag([fact('loose', [])], catalog)
    expect(groups.map((group) => group.title)).toEqual(['Untagged'])
  })
})

describe('orderSearchHits', () => {
  it('puts durable facts ahead of conversation snippets', () => {
    const hits: BrainSearchHit[] = [
      { id: 'episode-1', kind: 'episode', sentence: 'I live in Canby', arms: ['keyword'] },
      { id: 'claim-city', kind: 'claim', sentence: 'The user lives in Canby, Oregon.', arms: ['keyword'] },
    ]
    expect(orderSearchHits(hits).map((hit) => hit.id)).toEqual(['claim-city', 'episode-1'])
  })
})
