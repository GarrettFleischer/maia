import {
  parseBrainMap,
  type BrainIndex,
  type BrainMap,
  type BrainMapClient,
  type BrainSearchHit,
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
    search(query: string) {
      return readHits(
        fetch(`${root}/api/brain/search`, {
          method: 'POST',
          headers: withCsrf('POST', { 'content-type': 'application/json' }),
          body: JSON.stringify({ query }),
        }),
      )
    },
    editClaim(id: string, sentence: string) {
      return readMap(
        fetch(`${root}/api/brain/claims/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: withCsrf('PATCH', { 'content-type': 'application/json' }),
          body: JSON.stringify({ sentence }),
        }),
      )
    },
    confirmClaim(id: string) {
      return readMap(
        fetch(`${root}/api/brain/claims/${encodeURIComponent(id)}/confirm`, {
          method: 'POST',
          headers: withCsrf('POST', {}),
        }),
      )
    },
    forgetClaim(id: string) {
      return readMap(
        fetch(`${root}/api/brain/claims/${encodeURIComponent(id)}/forget`, {
          method: 'POST',
          headers: withCsrf('POST', {}),
        }),
      )
    },
    restoreClaim(id: string) {
      return readMap(
        fetch(`${root}/api/brain/claims/${encodeURIComponent(id)}/restore`, {
          method: 'POST',
          headers: withCsrf('POST', {}),
        }),
      )
    },
    createTag(name: string) {
      return readMap(
        fetch(`${root}/api/brain/tags`, {
          method: 'POST',
          headers: withCsrf('POST', { 'content-type': 'application/json' }),
          body: JSON.stringify({ name }),
        }),
      )
    },
    renameTag(id: string, name: string) {
      return readMap(
        fetch(`${root}/api/brain/tags/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: withCsrf('PATCH', { 'content-type': 'application/json' }),
          body: JSON.stringify({ name }),
        }),
      )
    },
    mergeTags(keepId: string, dropId: string) {
      return readMap(
        fetch(`${root}/api/brain/tags/merge`, {
          method: 'POST',
          headers: withCsrf('POST', { 'content-type': 'application/json' }),
          body: JSON.stringify({ keep: keepId, drop: dropId }),
        }),
      )
    },
    removeTag(id: string) {
      return readMap(
        fetch(`${root}/api/brain/tags/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: withCsrf('DELETE', {}),
        }),
      )
    },
    setClaimTags(id: string, tags: readonly string[]) {
      return readMap(
        fetch(`${root}/api/brain/claims/${encodeURIComponent(id)}/tags`, {
          method: 'PUT',
          headers: withCsrf('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ tags }),
        }),
      )
    },
    dismissQuarantinedEpisode(episodeId: string) {
      return readMap(
        fetch(`${root}/api/brain/episodes/${encodeURIComponent(episodeId)}/skip`, {
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

async function readHits(request: Promise<Response>): Promise<BrainSearchHit[]> {
  const response = await request
  if (!response.ok) throw new Error('The brain search could not be read.')
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !Array.isArray((body as { hits?: unknown }).hits)) {
    throw new Error('The brain search could not be read.')
  }
  return (body as { hits: BrainSearchHit[] }).hits
}

async function readMap(request: Promise<Response>): Promise<BrainMap> {
  const response = await request
  if (!response.ok) {
    throw new Error('The brain map could not be read.')
  }
  return parseBrainMap(await response.json())
}
