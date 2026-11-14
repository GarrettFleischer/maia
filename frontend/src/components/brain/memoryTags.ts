import type { BrainNode, BrainSearchHit } from '@/components/brain/layoutBrainMap'

export interface MemoryTag {
  id: string
  name: string
  role: string
}

export interface MemoryGroup {
  id: string
  title: string
  nodes: BrainNode[]
}

/** Facts appear once, under their first tag. Empty tags stay out of the list. */
export function groupFactsByPrimaryTag(
  facts: readonly BrainNode[],
  catalog: readonly MemoryTag[],
): MemoryGroup[] {
  const groups = new Map<string, MemoryGroup>()
  for (const fact of facts) {
    const title = fact.tags?.[0] || 'Untagged'
    const known = catalog.find((tag) => tag.name === title)
    const group = groups.get(title) ?? { id: known?.id ?? title, title, nodes: [] }
    group.nodes.push(fact)
    groups.set(title, group)
  }
  const order = new Map(catalog.map((tag, index) => [tag.name, index]))
  return [...groups.values()]
    .filter((group) => group.nodes.length > 0)
    .sort((left, right) => {
      if (left.title === 'Untagged') return 1
      if (right.title === 'Untagged') return -1
      const leftOrder = order.get(left.title) ?? order.size
      const rightOrder = order.get(right.title) ?? order.size
      return leftOrder - rightOrder || left.title.localeCompare(right.title)
    })
}

/** Durable facts stay ahead of conversation snippets. */
export function orderSearchHits(hits: readonly BrainSearchHit[]): BrainSearchHit[] {
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((left, right) => searchRank(left.hit.kind) - searchRank(right.hit.kind) || left.index - right.index)
    .map((item) => item.hit)
}

function searchRank(kind: string): number {
  return kind === 'claim' || kind === 'fact' ? 0 : 1
}

export function searchKindLabel(kind: string): string {
  return kind === 'episode' ? 'Conversation' : 'Fact'
}

/** Honest leaf: what a search hit should do when the owner opens it. */
export function searchHitAction(kind: string): 'open_fact' | 'view_source' {
  return kind === 'claim' || kind === 'fact' ? 'open_fact' : 'view_source'
}
