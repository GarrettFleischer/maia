import {
  parseBrainMap,
  type BrainIndex,
  type BrainMap,
  type BrainMapClient,
} from '@/components/brain/layoutBrainMap'
import { withCsrf } from '@/remote/csrf'

export function liveBrainMapClient(origin: string): BrainMapClient {
  const root = origin.replace(/\/$/, '')
  return {
    load() {
      return readMap(fetch(`${root}/api/brain/map`))
    },
    reviseFact(id, sentence) {
      return readMap(
        fetch(`${root}/api/brain/facts/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: withCsrf('PATCH', { 'content-type': 'application/json' }),
          body: JSON.stringify({ sentence }),
        }),
      )
    },
    deleteFact(id) {
      return readMap(
        fetch(`${root}/api/brain/facts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: withCsrf('DELETE', {}),
        }),
      )
    },
    loadIndex() {
      return readIndex(fetch(`${root}/api/brain/index`))
    },
    exportMarkdown() {
      return readIndex(
        fetch(`${root}/api/brain/export`, {
          method: 'POST',
          headers: withCsrf('POST', {}),
        }),
      )
    },
  }
}

async function readIndex(request: Promise<Response>): Promise<BrainIndex> {
  const response = await request
  if (!response.ok) {
    throw new Error('The brain index could not be read.')
  }
  const body: unknown = await response.json()
  if (!isIndex(body)) {
    throw new Error('The brain index could not be read.')
  }
  return body
}

function isIndex(body: unknown): body is BrainIndex {
  if (typeof body !== 'object' || body === null) return false
  const record = body as Record<string, unknown>
  return (
    (record.exported_at === null || typeof record.exported_at === 'number') &&
    typeof record.neuron_count === 'number' &&
    typeof record.edge_count === 'number' &&
    typeof record.keyword_count === 'number' &&
    typeof record.vector_count === 'number' &&
    typeof record.graph_count === 'number'
  )
}

async function readMap(request: Promise<Response>): Promise<BrainMap> {
  const response = await request
  if (!response.ok) {
    throw new Error('The brain map could not be read.')
  }
  return parseBrainMap(await response.json())
}
