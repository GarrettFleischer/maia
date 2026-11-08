import {
  emptyBrainMap,
  validateFactSentence,
  type BrainMap,
  type BrainMapClient,
} from '@/components/brain/layoutBrainMap'

export function memoryBrainMapClient(initial: BrainMap = emptyBrainMap()): BrainMapClient {
  let map = initial
  return {
    async load() {
      return map
    },
    async reviseFact(id, sentence) {
      const problem = validateFactSentence(sentence)
      if (problem) throw new Error(problem)
      const stored = sentence.trim()
      map = {
        nodes: map.nodes.map((node) =>
          node.id === id && node.kind === 'fact' ? { ...node, label: stored, sentence: stored } : node,
        ),
        edges: map.edges,
      }
      return map
    },
    async deleteFact(id) {
      map = {
        nodes: map.nodes.filter((node) => !(node.id === id && node.kind === 'fact')),
        edges: map.edges.filter((edge) => edge.from_id !== id && edge.to_id !== id),
      }
      return map
    },
  }
}
