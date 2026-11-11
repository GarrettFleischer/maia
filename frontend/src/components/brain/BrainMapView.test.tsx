import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BrainMapView } from '@/components/brain/BrainMapView'
import type { BrainMap, BrainMapClient } from '@/components/brain/layoutBrainMap'

function sampleMap(): BrainMap {
  return {
    nodes: [
      {
        id: 'fact-a',
        kind: 'fact',
        label: 'Alpha stays.',
        sentence: 'Alpha stays.',
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
      },
      {
        id: 'fact-b',
        kind: 'fact',
        label: 'Beta stays.',
        sentence: 'Beta stays.',
        taint: 'untrusted',
        session_id: 'thread-2',
        held: false,
      },
    ],
    edges: [],
  }
}

function clientFor(initial: BrainMap) {
  let map = initial
  const revisions: string[] = []
  const deletions: string[] = []
  const client: BrainMapClient = {
    async load() {
      return map
    },
    async reviseFact(id, sentence) {
      revisions.push(`${id}|${sentence}`)
      map = {
        ...map,
        nodes: map.nodes.map((node) =>
          node.id === id ? { ...node, label: sentence, sentence } : node,
        ),
      }
      return map
    },
    async deleteFact(id) {
      deletions.push(id)
      map = {
        nodes: map.nodes.filter((node) => node.id !== id),
        edges: map.edges.filter((edge) => edge.from_id !== id && edge.to_id !== id),
      }
      return map
    },
  }
  return { client, revisions, deletions }
}

describe('BrainMapView', () => {
  it('says when nothing has been promoted and still offers search', async () => {
    const { client } = clientFor({ nodes: [], edges: [] })
    render(<BrainMapView client={client} />)
    expect(await screen.findByText('Nothing has been promoted yet. Episodes remain searchable.')).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'Search the brain' })).toHaveAttribute(
      'placeholder',
      'Search the brain',
    )
  })

  it('narrows the graph and the mirrored list with the same search', async () => {
    const user = userEvent.setup()
    const { client } = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    const list = await screen.findByRole('list', { name: 'Brain nodes' })
    expect(within(list).getAllByRole('button')).toHaveLength(2)
    expect(screen.getAllByTestId(/brain-graph-/)).toHaveLength(2)

    expect(screen.getByRole('searchbox', { name: 'Search the brain' })).toHaveAttribute(
      'placeholder',
      'Search the brain',
    )
    await user.type(screen.getByRole('searchbox', { name: 'Search the brain' }), 'Alpha')

    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(within(list).getByRole('button', { name: 'Alpha stays. Trusted' })).toBeVisible()
    expect(screen.getAllByTestId(/brain-graph-/)).toHaveLength(1)
    expect(screen.getByTestId('brain-graph-fact-a')).toBeInTheDocument()
  })

  it('hides sentence editing until Edit is chosen', async () => {
    const user = userEvent.setup()
    const { client } = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    const list = await screen.findByRole('list', { name: 'Brain nodes' })
    await user.click(within(list).getByRole('button', { name: 'Alpha stays. Trusted' }))
    expect(screen.queryByRole('textbox', { name: 'Fact sentence' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Trim fact' })).not.toBeInTheDocument()
  })

  it('saves a new sentence and removes a trimmed fact after confirmation', async () => {
    const user = userEvent.setup()
    const { client, revisions, deletions } = clientFor(sampleMap())
    render(<BrainMapView client={client} />)
    const list = await screen.findByRole('list', { name: 'Brain nodes' })
    await user.click(screen.getByRole('radio', { name: 'Edit' }))
    await user.click(within(list).getByRole('button', { name: 'Alpha stays. Trusted' }))
    const field = screen.getByRole('textbox', { name: 'Fact sentence' })
    await user.clear(field)
    await user.type(field, 'Alpha moved.')
    await user.click(screen.getByRole('button', { name: 'Save sentence' }))

    expect(revisions).toEqual(['fact-a|Alpha moved.'])
    expect(within(list).getByRole('button', { name: 'Alpha moved. Trusted' })).toBeVisible()
    expect(within(list).queryByRole('button', { name: 'Alpha stays. Trusted' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(revisions).toEqual(['fact-a|Alpha moved.'])

    await user.click(screen.getByRole('button', { name: 'Trim fact' }))
    expect(deletions).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Remove this fact' }))
    expect(deletions).toEqual(['fact-a'])
    expect(within(list).queryByRole('button', { name: 'Alpha moved. Trusted' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('brain-graph-fact-a')).not.toBeInTheDocument()
  })
})
