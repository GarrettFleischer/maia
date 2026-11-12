import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BrainMapView } from '@/components/brain/BrainMapView'
import type { BrainMap, BrainMapClient, BrainSearchHit } from '@/components/brain/layoutBrainMap'

function sampleMap(): BrainMap {
  return {
    nodes: [
      {
        id: 'claim-name',
        kind: 'claim',
        label: 'The user\'s name is Garrett.',
        sentence: 'The user\'s name is Garrett.',
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
        category: 'person',
        subject: 'Owner',
        confidence_millis: 900,
        created_at: 1700000000,
        source_episode: 'episode-1',
      },
      {
        id: 'claim-city',
        kind: 'claim',
        label: 'The user lives in Canby, Oregon.',
        sentence: 'The user lives in Canby, Oregon.',
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
        category: 'place',
        subject: 'Owner',
        confidence_millis: 500,
        source_episode: 'episode-1',
      },
      {
        id: 'episode-1',
        kind: 'episode',
        label: 'Where I live',
        sentence: 'Owner: I live in Canby.',
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
      },
      {
        id: 'lexeme-this',
        kind: 'lexeme',
        label: 'this',
        sentence: null,
        taint: null,
        session_id: null,
        held: false,
      },
      {
        id: 'entity-owner',
        kind: 'entity',
        label: 'Owner',
        sentence: null,
        taint: 'trusted',
        session_id: null,
        held: false,
        entity_kind: 'person',
      },
    ],
    edges: [],
    hidden: [
      {
        id: 'claim-junk',
        kind: 'claim',
        label: 'Handed this message to the running task.',
        sentence: 'Handed this message to the running task.',
        taint: 'trusted',
        session_id: null,
        held: false,
        hidden_reason: 'not a durable fact',
      },
    ],
  }
}

function clientFor(initial: BrainMap, hits: BrainSearchHit[] = []) {
  let map = initial
  const client: BrainMapClient = {
    async load() {
      return map
    },
    async reviseFact() {
      return map
    },
    async deleteFact(id) {
      map = { ...map, nodes: map.nodes.filter((node) => node.id !== id) }
      return map
    },
    async search() {
      return hits
    },
    async editClaim(id, sentence) {
      map = {
        ...map,
        nodes: map.nodes.map((node) =>
          node.id === id ? { ...node, sentence, label: sentence, confidence_millis: 1000 } : node,
        ),
      }
      return map
    },
    async forgetClaim(id) {
      const node = map.nodes.find((item) => item.id === id)
      map = {
        ...map,
        nodes: map.nodes.filter((item) => item.id !== id),
        hidden: node ? [...(map.hidden ?? []), node] : map.hidden,
      }
      return map
    },
    async restoreClaim(id) {
      const node = (map.hidden ?? []).find((item) => item.id === id)
      map = {
        ...map,
        hidden: (map.hidden ?? []).filter((item) => item.id !== id),
        nodes: node ? [...map.nodes, { ...node, hidden_reason: null }] : map.nodes,
      }
      return map
    },
  }
  return client
}

describe('BrainMapView', () => {
  it('opens on Memory and keeps export in Settings / Sync', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    client.exportMarkdown = async () => ({
      exported_at: 1700000001,
      neuron_count: 4,
      edge_count: 2,
      keyword_count: 3,
      vector_count: 1,
      graph_count: 2,
    })
    client.loadIndex = async () => ({
      exported_at: 1700000000,
      neuron_count: 4,
      edge_count: 2,
      keyword_count: 3,
      vector_count: 1,
      graph_count: 2,
    })
    render(<BrainMapView client={client} />)
    expect(await screen.findByRole('heading', { name: 'About you' })).toBeVisible()
    expect(screen.getByText("The user's name is Garrett.")).toBeVisible()
    expect(screen.queryByText('this')).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings / Sync'))
    expect(screen.getByText(/Last export 1700000000/)).toBeVisible()
    expect(screen.getByText(/keyword 3 · vector 1 · graph 2/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Export markdown' })).toBeVisible()
  })

  it('explains an empty memory and still offers search', async () => {
    const client = clientFor({ nodes: [], edges: [] })
    render(<BrainMapView client={client} />)
    expect(await screen.findByText(/Nothing has been promoted yet/)).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search the brain' })).toBeVisible()
  })

  it('searches with recall arms', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap(), [
      { id: 'claim-city', kind: 'claim', sentence: 'The user lives in Canby, Oregon.', arms: ['keyword', 'graph'] },
    ])
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'About you' })
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search the brain' }), 'where do I live')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(within(results).getByText('The user lives in Canby, Oregon.')).toBeVisible()
    expect(within(results).getByText('keyword')).toBeVisible()
    expect(within(results).getByText('graph')).toBeVisible()
  })

  it('reviews a low-confidence fact and restores a hidden one', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'About you' })
    await user.click(screen.getByRole('tab', { name: 'Review' }))
    expect(screen.getByText('The user lives in Canby, Oregon.')).toBeVisible()
    expect(screen.queryByText("The user's name is Garrett.")).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(screen.getByText('Nothing is waiting for review.')).toBeVisible()
    await user.click(screen.getByText('Hidden'))
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await user.click(screen.getByRole('tab', { name: 'Memory' }))
    expect(screen.getByText('Handed this message to the running task.')).toBeVisible()
  })

  it('shows conversations and the facts that came from them', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'About you' })
    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    const timeline = screen.getByRole('list', { name: 'Timeline' })
    expect(within(timeline).getByText('Owner: I live in Canby.')).toBeVisible()
    expect(within(timeline).getByText("The user's name is Garrett.")).toBeVisible()
  })

  it('draws entities and claims and leaves lexemes out', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'About you' })
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(screen.getByTestId('brain-graph-entity-owner')).toBeInTheDocument()
    expect(screen.getByTestId('brain-graph-claim-name')).toBeInTheDocument()
    expect(screen.queryByTestId('brain-graph-lexeme-this')).not.toBeInTheDocument()
  })
})
