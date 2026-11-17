import { describe, expect, it } from 'vitest'
import type { BrainNode, BrainSearchHit } from '@/components/brain/layoutBrainMap'
import {
  filterFactsByTag,
  orderSearchHits,
  searchHitAction,
  tagCounts,
  UNTAGGED,
  type MemoryTag,
} from '@/components/brain/memoryTags'

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

describe('tagCounts', () => {
  it('counts every tag a fact carries in catalog order and leaves out empty tags', () => {
    const counts = tagCounts(
      [fact('city', ['Places']), fact('name', ['People', 'Ideas']), fact('path', ['Things']), fact('loose', [])],
      catalog,
    )
    expect(counts).toEqual([
      { name: 'People', count: 1 },
      { name: 'Places', count: 1 },
      { name: 'Things', count: 1 },
      { name: 'Ideas', count: 1 },
      { name: UNTAGGED, count: 1 },
    ])
  })
})

describe('filterFactsByTag', () => {
  const all = [fact('city', ['Places']), fact('name', ['People', 'Ideas']), fact('loose', [])]

  it('keeps every fact in one flat list with no filter', () => {
    expect(filterFactsByTag(all, null).map((node) => node.id)).toEqual(['city', 'name', 'loose'])
  })

  it('matches any tag on a fact, not only the first', () => {
    expect(filterFactsByTag(all, 'Ideas').map((node) => node.id)).toEqual(['name'])
  })

  it('shows facts with no tag under Untagged', () => {
    expect(filterFactsByTag(all, UNTAGGED).map((node) => node.id)).toEqual(['loose'])
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

describe('searchHitAction', () => {
  it('opens durable facts for edit and conversations for source', () => {
    expect(searchHitAction('claim')).toBe('open_fact')
    expect(searchHitAction('fact')).toBe('open_fact')
    expect(searchHitAction('episode')).toBe('view_source')
    expect(searchHitAction('lexeme')).toBe('view_source')
  })
})
