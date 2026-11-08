import type { BrainEdge, BrainMap, BrainNode } from '@/components/brain/layoutBrainMap'

export const ROUTER_BRAIN_THREAD = 'router'

export function inspectorBrainMap(map: BrainMap, recallIds: ReadonlySet<string>): BrainMap {
  const kept = map.nodes.filter((node) => recalledOrRouterEpisode(node, recallIds))
  const keptIds = new Set(kept.map((node) => node.id))
  const lexemes = map.nodes.filter(
    (node) => node.kind === 'lexeme' && lexemeTouches(node.id, map.edges, keptIds),
  )
  const ids = new Set([...keptIds, ...lexemes.map((node) => node.id)])
  return {
    nodes: map.nodes.filter((node) => ids.has(node.id)),
    edges: map.edges.filter((edge) => ids.has(edge.from_id) && ids.has(edge.to_id)),
  }
}

export function inspectorBrainHasFactOrEpisode(map: BrainMap): boolean {
  return map.nodes.some((node) => node.kind === 'fact' || node.kind === 'episode')
}

function recalledOrRouterEpisode(node: BrainNode, recallIds: ReadonlySet<string>): boolean {
  if (node.kind === 'episode') return node.session_id === ROUTER_BRAIN_THREAD
  if (node.kind === 'claim' || node.kind === 'fact') return recallIds.has(node.id)
  return false
}

function lexemeTouches(id: string, edges: readonly BrainEdge[], kept: ReadonlySet<string>): boolean {
  return edges.some(
    (edge) =>
      (edge.from_id === id && kept.has(edge.to_id)) || (edge.to_id === id && kept.has(edge.from_id)),
  )
}
