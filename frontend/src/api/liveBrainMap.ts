import {
  parseBrainMap,
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
  }
}

async function readMap(request: Promise<Response>): Promise<BrainMap> {
  const response = await request
  if (!response.ok) {
    throw new Error('The brain map could not be read.')
  }
  return parseBrainMap(await response.json())
}
