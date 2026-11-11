import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { InspectorTurn } from '@/api/superAgentTypes'
import type { BrainMap } from '@/components/brain/layoutBrainMap'
import { InspectorPanel } from '@/components/inspector/InspectorPanel'
import {
  nextInspectorTab,
  type InspectorNavigationKey,
  type InspectorTabId,
} from '@/components/inspector/inspectorTabs'
import { defaultInspectorFixture } from '@/fixtures/inspectorFixture'

describe('nextInspectorTab', () => {
  it.each<readonly [InspectorTabId, InspectorNavigationKey, InspectorTabId]>([
    ['cache', 'ArrowRight', 'brain'],
    ['brain', 'ArrowRight', 'trace'],
    ['trace', 'ArrowRight', 'cache'],
    ['cache', 'ArrowLeft', 'trace'],
    ['cache', 'End', 'trace'],
    ['trace', 'Home', 'cache'],
  ])('moves from %s with %s to %s', (current, key, expected) => {
    expect(nextInspectorTab(current, key)).toBe(expected)
  })
})

describe('InspectorPanel tabs', () => {
  it('uses one tab stop with wrapping arrows, Home, End, click, and associated panels', async () => {
    const user = userEvent.setup()
    render(
      <InspectorPanel
        surface="docked"
        open
        onClose={() => undefined}
        data={defaultInspectorFixture()}
      />,
    )
    const cache = screen.getByRole('tab', { name: 'Cache' })
    const brain = screen.getByRole('tab', { name: 'Brain' })
    const trace = screen.getByRole('tab', { name: 'Trace' })

    expect(cache).toHaveAttribute('tabindex', '0')
    expect(brain).toHaveAttribute('tabindex', '-1')
    expect(trace).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', cache.id)
    expect(cache).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id)

    cache.focus()
    await user.keyboard('{ArrowLeft}')
    expect(trace).toHaveFocus()
    expect(trace).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{Home}')
    expect(cache).toHaveFocus()
    await user.keyboard('{End}')
    expect(trace).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(cache).toHaveFocus()

    await user.click(brain)
    expect(brain).toHaveFocus()
    expect(brain).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', brain.id)
  })

  it('shows cache, brain, and trace when the live report is empty', async () => {
    const user = userEvent.setup()
    render(<InspectorPanel surface="docked" open onClose={() => undefined} />)
    expect(screen.getByRole('tab', { name: 'Cache' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('No context usage for this turn.')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Brain' }))
    expect(screen.getByText('No brain report for this turn.')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Trace' }))
    expect(screen.getByText('No trace for this turn.')).toBeVisible()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()
  })

  it('renders a stored turn and scrubs to an unreported cache', async () => {
    const user = userEvent.setup()
    render(
      <InspectorPanel surface="docked" open onClose={() => undefined} live={{ turns: liveTurns(), brain: liveBrain() }} />,
    )

    expect(screen.getAllByText('25%').length).toBeGreaterThan(0)
    expect(screen.getByText('Recall · not durable')).toBeVisible()
    expect(screen.getByText('Obsidian opens the vault.')).toBeVisible()
    expect(screen.getByText('Untrusted')).toBeVisible()
    expect(screen.getByTestId('inspector-live-slot-1')).toHaveTextContent('Route tools')
    expect(screen.getByTestId('inspector-live-slot-4')).toHaveTextContent('1 message')
    expect(screen.queryByText(/compact/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Tailscale')).not.toBeInTheDocument()
    expect(screen.queryByText('Persona · Scout')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Trace' }))
    expect(screen.getByText('No readable reasoning returned.')).toBeVisible()
    expect(screen.getByText('admitted by host')).toBeVisible()
    expect(screen.getByText('spawn_task')).toBeVisible()
    expect(screen.queryByText(/match/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Brain' }))
    expect(screen.getByText('Router exchange')).toBeVisible()
    expect(screen.queryByText('Other thread')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Cache' }))
    fireEvent.change(screen.getByRole('slider', { name: 'Turn scrubber' }), { target: { value: '1' } })
    expect(screen.getByText('Cache not reported')).toBeVisible()
    expect(screen.queryByText('Obsidian opens the vault.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Trace' }))
    expect(screen.getByText('Hello from Maia.')).toBeVisible()
  })
})

function liveTurns(): InspectorTurn[] {
  return [
    {
      ordinal: 1,
      message_id: 'm-1',
      cached_percent: null,
      slots: [
        { ordinal: 1, label: 'Route tools', bytes: 40, residence: 'unreported', detail: '5 schemas' },
        { ordinal: 2, label: 'Router instructions', bytes: 800, residence: 'unreported', detail: 'fixed' },
        { ordinal: 3, label: 'Candidate tasks', bytes: 2, residence: 'unreported', detail: '0 tasks' },
        { ordinal: 4, label: 'Conversation', bytes: 5, residence: 'unreported', detail: '1 message' },
      ],
      recall: [],
      thinking: null,
      route: null,
      reply: 'Hello from Maia.',
      trace: [
        { kind: 'reasoning', text: 'No readable reasoning returned.' },
        { kind: 'reply', text: 'Hello from Maia.' },
      ],
    },
    {
      ordinal: 2,
      message_id: 'm-2',
      cached_percent: 25,
      slots: [
        { ordinal: 1, label: 'Route tools', bytes: 40, residence: 'unreported', detail: '5 schemas' },
        { ordinal: 2, label: 'Router instructions', bytes: 800, residence: 'unreported', detail: 'fixed' },
        { ordinal: 3, label: 'Candidate tasks', bytes: 2, residence: 'unreported', detail: '0 tasks' },
        { ordinal: 4, label: 'Conversation', bytes: 5, residence: 'unreported', detail: '1 message' },
        { ordinal: 5, label: 'Recall', bytes: 30, residence: 'unreported', detail: 'not durable' },
      ],
      recall: [{ id: 'claim-1', kind: 'claim', sentence: 'Obsidian opens the vault.', score: 0.5 }],
      thinking: null,
      route: 'spawn_task',
      reply: 'Dispatched as one new task: Hello.',
      trace: [
        { kind: 'reasoning', text: 'No readable reasoning returned.' },
        { kind: 'route', text: 'spawn_task' },
        { kind: 'reply', text: 'Dispatched as one new task: Hello.' },
      ],
    },
  ]
}

function liveBrain(): BrainMap {
  return {
    nodes: [
      {
        id: 'episode-router',
        kind: 'episode',
        label: 'Router exchange',
        sentence: null,
        taint: 'trusted',
        session_id: 'router',
        held: false,
      },
      {
        id: 'episode-other',
        kind: 'episode',
        label: 'Other thread',
        sentence: null,
        taint: 'trusted',
        session_id: 'thread-1',
        held: false,
      },
      {
        id: 'claim-1',
        kind: 'claim',
        label: 'Obsidian opens the vault.',
        sentence: 'Obsidian opens the vault.',
        taint: 'untrusted',
        session_id: 'thread-1',
        held: false,
      },
    ],
    edges: [],
  }
}
