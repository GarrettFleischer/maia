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
        created_at: 1700000000,
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
    async deleteClaim(id) {
      map = {
        ...map,
        nodes: map.nodes.filter((item) => item.id !== id),
        hidden: (map.hidden ?? []).filter((item) => item.id !== id),
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
    expect(await screen.findByText("The user's name is Garrett.")).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument()
    expect(screen.queryByText('this')).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings / Sync'))
    expect(screen.getByText(/Last exported .* · 4 notes\./)).toBeVisible()
    expect(screen.queryByText(/keyword 3/)).not.toBeInTheDocument()
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

  it('lets the owner dismiss a quarantined episode from the behind banner', async () => {
    const user = userEvent.setup()
    let map: BrainMap = {
      nodes: [],
      edges: [],
      extraction: {
        waiting: 0,
        quarantined: 1,
        oldest_waiting_at: null,
        paused_for_day: false,
        quarantined_episodes: ['episode-m-999428'],
      },
    }
    const client = clientFor(map)
    client.dismissQuarantinedEpisode = async (episodeId) => {
      expect(episodeId).toBe('episode-m-999428')
      map = {
        ...map,
        extraction: {
          waiting: 0,
          quarantined: 0,
          oldest_waiting_at: null,
          paused_for_day: false,
          quarantined_episodes: [],
        },
      }
      return map
    }
    render(<BrainMapView client={client} />)
    expect(await screen.findByTestId('memory-behind')).toHaveTextContent(
      'Memory could not learn 1 stuck note.',
    )
    await user.click(screen.getByRole('button', { name: 'Dismiss stuck note episode-m-999428' }))
    expect(screen.queryByTestId('memory-behind')).not.toBeInTheDocument()
  })

  it('searches without showing internal match labels', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap(), [
      { id: 'episode-1', kind: 'episode', sentence: 'I live in Canby', arms: ['keyword'] },
      { id: 'claim-city', kind: 'claim', sentence: 'The user lives in Canby, Oregon.', arms: ['keyword', 'graph'] },
    ])
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search the brain' }), 'where do I live')
    const searchBtn = screen.getByRole('button', { name: 'Search' })
    expect(searchBtn).toHaveClass('maia-icon-btn')
    expect(searchBtn).not.toHaveTextContent('Search')
    await user.click(searchBtn)
    const results = await screen.findByRole('list', { name: 'Search results' })
    expect(within(results).getByText('The user lives in Canby, Oregon.')).toBeVisible()
    expect(within(results).queryByText('keyword')).toBeNull()
    expect(within(results).queryByText('graph')).toBeNull()
    const items = within(results).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('The user lives in Canby, Oregon.')
    expect(items[0]).toHaveTextContent('Fact')
    expect(items[1]).toHaveTextContent('Conversation')
  })

  it('opens a fact hit for edit and a conversation hit on the timeline', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap(), [
      { id: 'episode-1', kind: 'episode', sentence: 'I live in Canby', arms: ['keyword'] },
      { id: 'claim-city', kind: 'claim', sentence: 'The user lives in Canby, Oregon.', arms: ['keyword'] },
    ])
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search the brain' }), 'Canby')
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const results = await screen.findByRole('list', { name: 'Search results' })
    await user.click(within(results).getByRole('button', { name: 'Open fact' }))
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByDisplayValue('The user lives in Canby, Oregon.')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Search' }))
    await user.click(screen.getByRole('button', { name: 'Search' }))
    const again = await screen.findByRole('list', { name: 'Search results' })
    await user.click(within(again).getByRole('button', { name: 'View source' }))
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Source: episode-1')).toBeVisible()
  })

  it('reviews a low-confidence fact and restores a hidden one', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
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
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    const timeline = screen.getByRole('list', { name: 'Timeline' })
    expect(within(timeline).getByText('Owner: I live in Canby.')).toBeVisible()
    expect(within(timeline).getByText("The user's name is Garrett.")).toBeVisible()
  })

  it('shows compact dates on timeline entries when created_at is present', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Timeline' }))
    const timeline = screen.getByRole('list', { name: 'Timeline' })
    const items = within(timeline).getAllByRole('listitem')
    // First item should have both episode and fact with dates
    expect(items[0]).toHaveTextContent('11/14/2023')
    expect(items[0]).toHaveTextContent("The user's name is Garrett.")
  })

  it('draws entities and claims and leaves lexemes out', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(screen.getByTestId('brain-graph-entity-owner')).toBeInTheDocument()
    expect(screen.getByTestId('brain-graph-claim-name')).toBeInTheDocument()
    expect(screen.queryByTestId('brain-graph-lexeme-this')).not.toBeInTheDocument()
  })

  it('keeps the brain views in one compact icon tab row with names and a label on the active tab', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    const tablist = screen.getByRole('tablist', { name: 'Brain views' })
    expect(tablist).toHaveClass('maia-brain-tabs')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Memory',
      'Skills',
      'Search',
      'Review',
      'Timeline',
      'Graph',
    ])
    for (const tab of tabs) {
      expect(tab).toHaveClass('maia-icon-btn')
      expect(tab.getAttribute('title')).toBeTruthy()
      expect(tab.querySelector('.maia-brain-tab-icon')).not.toBeNull()
    }
    expect(screen.getByRole('tab', { name: 'Memory' })).toHaveTextContent('Memory')
    expect(screen.getByRole('tab', { name: 'Graph' })).not.toHaveTextContent('Graph')
    await user.click(screen.getByRole('tab', { name: 'Graph' }))
    expect(screen.getByRole('tab', { name: 'Graph' })).toHaveTextContent('Graph')
    expect(screen.getByRole('tab', { name: 'Memory' })).not.toHaveTextContent('Memory')
  })

  it('shows one flat memory list with tag chips, a tag filter, and one labeled action row each', async () => {
    const user = userEvent.setup()
    render(<BrainMapView client={clientFor(sampleMap())} />)
    await screen.findByText("The user's name is Garrett.")
    expect(screen.queryByRole('heading', { name: 'People' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Places' })).not.toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Memories' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    const fact = screen.getByText("The user's name is Garrett.").closest('article') as HTMLElement
    expect(within(fact).getByText('People')).toHaveClass('maia-chip')
    const actions = within(fact).getByRole('group', { name: 'Memory actions' })
    const names = within(actions)
      .getAllByRole('button')
      .map((button) => [button.getAttribute('aria-label'), button.getAttribute('title')])
    expect(names).toEqual([
      ['Edit', 'Edit'],
      ['Tag', 'Tag'],
      ['Delete', 'Delete'],
      ['Source', 'Source'],
    ])
    expect(actions.parentElement).toHaveClass('maia-memory-meta')
    expect(within(actions.parentElement as HTMLElement).getByText(/^Learned/)).toBeVisible()
    const filter = screen.getByRole('group', { name: 'Filter by tag' })
    await user.click(within(filter).getByRole('button', { name: 'Places 1' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByText('The user lives in Canby, Oregon.')).toBeVisible()
    expect(screen.queryByText("The user's name is Garrett.")).not.toBeInTheDocument()
    await user.click(within(filter).getByRole('button', { name: 'All 2' }))
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  it('deletes a memory for good only after a confirm, and can delete hidden ones too', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    const deleted: string[] = []
    const base = client.deleteClaim!.bind(client)
    client.deleteClaim = async (id) => {
      deleted.push(id)
      return base(id)
    }
    render(<BrainMapView client={client} />)
    const fact = (await screen.findByText("The user's name is Garrett.")).closest('article') as HTMLElement
    await user.click(within(fact).getByRole('button', { name: 'Delete' }))
    expect(deleted).toEqual([])
    await user.click(within(fact).getByRole('button', { name: 'Cancel' }))
    await user.click(within(fact).getByRole('button', { name: 'Delete' }))
    const confirm = within(fact).getByRole('group', { name: 'Confirm delete' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(deleted).toEqual(['claim-name'])
    expect(screen.queryByText("The user's name is Garrett.")).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Review' }))
    await user.click(screen.getByText('Hidden'))
    const hiddenRow = screen.getByText('Handed this message to the running task.').closest('li') as HTMLElement
    await user.click(within(hiddenRow).getByRole('button', { name: 'Delete' }))
    await user.click(within(within(hiddenRow).getByRole('group', { name: 'Confirm delete' })).getByRole('button', { name: 'Delete' }))
    expect(deleted).toEqual(['claim-name', 'claim-junk'])
    expect(screen.queryByText('Handed this message to the running task.')).not.toBeInTheDocument()
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
        subject: 'Owner',
        confidence_millis: 800,
        tags: ['Things'],
      },
    )
    render(<BrainMapView client={clientFor(map)} />)
    await screen.findByText("The user's name is Garrett.")
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

  it('keeps tag rename controls out of the page until a tag is picked and Edit tag is opened', async () => {
    const user = userEvent.setup()
    render(<BrainMapView client={clientFor(sampleMap())} />)
    expect(await screen.findByText("The user's name is Garrett.")).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit tag People' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'People 1' }))
    expect(screen.queryByRole('textbox', { name: 'Rename People', hidden: true })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit tag People' }))
    const editor = screen.getByRole('button', { name: 'Edit tag People' }).closest('.maia-tag-edit')
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
    expect(await screen.findByText("The user's name is Garrett.")).toBeVisible()
    const filter = screen.getByRole('group', { name: 'Filter by tag' })
    expect(within(filter).queryByRole('button', { name: /^Ideas/ })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'New tag' }), 'Dogs')
    const addTag = screen.getByRole('button', { name: 'Add tag' })
    expect(addTag).toHaveClass('maia-icon-btn')
    expect(addTag).not.toHaveTextContent('Add tag')
    await user.click(addTag)
    const fact = () => screen.getByText("The user's name is Garrett.").closest('article') as HTMLElement
    await user.click(within(fact()).getByRole('button', { name: 'Tag' }))
    await user.click(screen.getByRole('checkbox', { name: 'Places' }))
    const saveTags = screen.getByRole('button', { name: 'Save tags' })
    expect(saveTags).toHaveClass('maia-icon-btn')
    expect(saveTags).not.toHaveTextContent('Save tags')
    await user.click(saveTags)
    expect(await within(fact()).findByText('Places')).toBeVisible()
    expect(within(fact()).getByText('People')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'People 1' }))
    await user.click(screen.getByRole('button', { name: 'Edit tag People' }))
    await user.click(screen.getByRole('button', { name: 'Remove People' }))
    expect(screen.getByRole('group', { name: 'Confirm remove People' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Confirm remove People' }))
    expect(screen.getByText("The user's name is Garrett.")).toBeVisible()
    expect(within(fact()).queryByText('People')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^People/ })).not.toBeInTheDocument()
  })

  it('lists skills with view and delete icons', async () => {
    const user = userEvent.setup()
    const client = clientFor(sampleMap())
    let skills = {
      skills: [
        {
          skill_id: 'sort-ints',
          title: 'Sort ints',
          when_to_use: 'When PowerShell sort fails on bare ints.',
          body: 'Use Sort-Object { [int]$_ }.',
          project: 'maia',
          max_tokens: 400,
          updated_at: 1,
        },
      ],
      catalog_tokens: 24,
    }
    client.loadSkills = async () => skills
    client.deleteSkill = async (id) => {
      skills = {
        skills: skills.skills.filter((skill) => skill.skill_id !== id),
        catalog_tokens: 0,
      }
      return skills
    }
    render(<BrainMapView client={client} />)
    await screen.findByText("The user's name is Garrett.")
    await user.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(await screen.findByTestId('skills-catalog-tokens')).toHaveTextContent('Catalog ≈ 24 tokens')
    expect(screen.getByText(/sort-ints/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'View sort-ints' }))
    expect(screen.getByTestId('skill-body-sort-ints')).toHaveTextContent('Sort-Object')
    await user.click(screen.getByRole('button', { name: 'Delete sort-ints' }))
    expect(screen.getByText(/No skills yet/)).toBeVisible()
  })
})

function drawnLines(id: string): string[] {
  return [...document.querySelectorAll(`[data-testid="brain-graph-${id}"] tspan`)].map(
    (node) => node.textContent ?? '',
  )
}
