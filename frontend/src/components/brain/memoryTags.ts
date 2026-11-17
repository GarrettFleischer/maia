import type { BrainNode, BrainSearchHit } from '@/components/brain/layoutBrainMap'

export interface MemoryTag {
  id: string
  name: string
  role: string
}

/** Filter value for facts that carry no tag. */
export const UNTAGGED = 'Untagged'

export interface TagCount {
  name: string
  count: number
}

/** Tags that have facts, in catalog order, with Untagged last. */
export function tagCounts(facts: readonly BrainNode[], catalog: readonly MemoryTag[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const fact of facts) {
    const names = fact.tags?.length ? fact.tags : [UNTAGGED]
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const order = new Map(catalog.map((tag, index) => [tag.name, index]))
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => {
      if (left.name === UNTAGGED) return 1
      if (right.name === UNTAGGED) return -1
      const leftOrder = order.get(left.name) ?? order.size
      const rightOrder = order.get(right.name) ?? order.size
      return leftOrder - rightOrder || left.name.localeCompare(right.name)
    })
}

/** One flat list. `null` keeps every fact; UNTAGGED keeps facts with no tag. */
export function filterFactsByTag(facts: readonly BrainNode[], tag: string | null): BrainNode[] {
  if (tag === null) return [...facts]
  if (tag === UNTAGGED) return facts.filter((fact) => !fact.tags?.length)
  return facts.filter((fact) => fact.tags?.includes(tag))
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
