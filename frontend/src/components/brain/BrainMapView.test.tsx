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
        tags: ['People'],
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
        tags: ['Places'],
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
    tags: [
      { id: 'tag-people', name: 'People', role: 'people' },
      { id: 'tag-places', name: 'Places', role: 'places' },
      { id: 'tag-things', name: 'Things', role: 'things' },
      { id: 'tag-ideas', name: 'Ideas', role: 'ideas' },
    ],
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
    async confirmClaim(id) {
      map = {
        ...map,
        nodes: map.nodes.map((node) =>
          node.id === id ? { ...node, confidence_millis: 1000 } : node,
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
    expect(await screen.findByRole('heading', { name: 'People' })).toBeVisible()
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

  it('shows memory is behind when the daily cap holds extraction', async () => {
    const client = clientFor({
      nodes: [],
      edges: [],
      extraction: {
        waiting: 4,
        quarantined: 0,
        oldest_waiting_at: null,
        paused_for_day: true,
        quarantined_episodes: [],
      },
    })
    render(<BrainMapView client={client} />)
    expect(await screen.findByTestId('memory-behind')).toHaveTextContent(
      'Memory is behind: 4 messages waiting to be remembered. Memory paused until tomorrow.',
    )
  })

  it('searches with recall arms', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap(), [
      { id: 'episode-1', kind: 'episode', sentence: 'I live in Canby', arms: ['keyword'] },
      { id: 'claim-city', kind: 'claim', sentence: 'The user lives in Canby, Oregon.', arms: ['keyword', 'graph'] },
    ])
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search the brain' }), 'where do I live')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(within(results).getByText('The user lives in Canby, Oregon.')).toBeVisible()
    expect(within(results).getAllByText('keyword').length).toBeGreaterThan(0)
    expect(within(results).getByText('graph')).toBeVisible()
    const items = within(results).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('The user lives in Canby, Oregon.')
    expect(items[0]).toHaveTextContent('Fact')
    expect(items[1]).toHaveTextContent('Conversation')
  })

  it('reviews a low-confidence fact and restores a hidden one', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'People' })
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
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    const timeline = screen.getByRole('list', { name: 'Timeline' })
    expect(within(timeline).getByText('Owner: I live in Canby.')).toBeVisible()
    expect(within(timeline).getByText("The user's name is Garrett.")).toBeVisible()
  })

  it('draws entities and claims and leaves lexemes out', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(screen.getByTestId('brain-graph-entity-owner')).toBeInTheDocument()
    expect(screen.getByTestId('brain-graph-claim-name')).toBeInTheDocument()
    expect(screen.queryByTestId('brain-graph-lexeme-this')).not.toBeInTheDocument()
  })

  it('keeps Memory, Search, Review, Timeline, and Graph in one tab row', async () => {
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByRole('heading', { name: 'People' })
    const tablist = screen.getByRole('tablist', { name: 'Brain views' })
    expect(tablist).toHaveClass('maia-brain-tabs')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Memory',
      'Search',
      'Review',
      'Timeline',
      'Graph',
    ])
  })

  it('draws short entity names and does not cut claim words', async () => {
    const user = userEvent.setup()
    const folder = 'The user has a folder located at F:\\Development\\Ideas.'
    const map = sampleMap()
    map.nodes.push(
      {
        id: 'entity-canby',
        kind: 'entity',
        label: 'Canby Oregon',
        sentence: 'Canby Oregon',
        taint: 'trusted',
        session_id: null,
        held: false,
        entity_kind: 'place',
      },
      {
        id: 'entity-ideas',
        kind: 'entity',
        label: 'F:\\Development\\Ideas',
        sentence: 'F:\\Development\\Ideas',
        taint: 'trusted',
        session_id: null,
        held: false,
        entity_kind: 'path',
      },
      {
        id: 'claim-folder',
        kind: 'claim',
        label: folder,
        sentence: folder,
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
        category: 'path',
        subject: 'Owner',
        confidence_millis: 800,
        tags: ['Things'],
      },
    )
    render(<BrainMapView client={clientFor(map)} />)
    await screen.findByRole('heading', { name: 'People' })
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(drawnLines('entity-owner')).toEqual(['Owner'])
    expect(drawnLines('entity-canby')).toEqual(['Canby'])
    expect(drawnLines('entity-ideas')).toEqual(['Ideas folder'])
    const claimLines = drawnLines('claim-folder')
    const shownWords = claimLines.join(' ').split(/\s+/)
    const words = folder.split(/\s+/)
    expect(words.slice(0, shownWords.length)).toEqual(shownWords)
    expect(claimLines.join(' ')).toContain('folder')
    expect(claimLines.join(' ')).not.toContain('fol ')
    expect(document.querySelector('[data-testid="brain-graph-claim-folder"] title')?.textContent).toBe(folder)
    expect(document.querySelector('[data-testid="brain-graph-entity-ideas"] title')?.textContent).toBe(
      'F:\\Development\\Ideas',
    )
    const svg = document.querySelector('.maia-brain-svg')
    const viewWidth = Number(svg?.getAttribute('viewBox')?.split(' ')[2])
    expect(viewWidth).toBeGreaterThan(0)
    expect(Number.parseFloat((svg as SVGElement | null)?.style.minWidth ?? '')).toBeGreaterThanOrEqual(viewWidth)
  })

  it('keeps tag rename controls out of the page until Edit is opened', async () => {
    const user = userEvent.setup()
    render(<BrainMapView client={clientFor(sampleMap())} />)
    expect(await screen.findByRole('heading', { name: 'People' })).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Rename People', hidden: true })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove People', hidden: true })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit People' }))
    const editor = screen.getByRole('button', { name: 'Edit People' }).closest('.maia-tag-edit')
    expect(editor).toHaveClass('is-open')
    expect(screen.getByRole('textbox', { name: 'Rename People' })).toBeVisible()
  })

  it('lets the owner add, retag, and remove a tag without dropping the fact', async () => {
    const user = userEvent.setup()
    let current = sampleMap()
    const client = clientFor(current)
    client.load = async () => current
    client.createTag = async (name) => {
      current = {
        ...current,
        tags: [...(current.tags ?? []), { id: `tag-${name}`, name, role: 'custom' }],
      }
      return current
    }
    client.setClaimTags = async (id, tags) => {
      current = {
        ...current,
        nodes: current.nodes.map((node) => (node.id === id ? { ...node, tags: [...tags] } : node)),
      }
      return current
    }
    client.removeTag = async (id) => {
      const name = current.tags?.find((tag) => tag.id === id)?.name
      current = {
        ...current,
        tags: (current.tags ?? []).filter((tag) => tag.id !== id),
        nodes: current.nodes.map((node) => ({
          ...node,
          tags: (node.tags ?? []).filter((tag) => tag !== name),
        })),
      }
      return current
    }
    render(<BrainMapView client={client} />)
    expect(await screen.findByRole('heading', { name: 'People' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Ideas' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'About you' })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'New tag' }), 'Dogs')
    await user.click(screen.getByRole('button', { name: 'Add tag' }))
    const people = await screen.findByRole('region', { name: 'People' })
    await user.click(within(people).getByRole('button', { name: 'Tags' }))
    await user.click(screen.getByRole('checkbox', { name: 'Places' }))
    await user.click(screen.getByRole('button', { name: 'Save tags' }))
    const fact = within(await screen.findByRole('region', { name: 'People' }))
      .getByText("The user's name is Garrett.")
      .closest('article')
    expect(within(fact as HTMLElement).getByText('Places')).toBeVisible()
    await user.click(screen.getByText('Edit People'))
    await user.click(screen.getByRole('button', { name: 'Remove People' }))
    expect(screen.getByText("The user's name is Garrett.")).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument()
  })
})

function drawnLines(id: string): string[] {
  return [...document.querySelectorAll(`[data-testid="brain-graph-${id}"] tspan`)].map(
    (node) => node.textContent ?? '',
  )
}
