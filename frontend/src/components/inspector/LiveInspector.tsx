import { useState } from 'react'
import { layoutBrainMap, type BrainMap } from '@/components/brain/layoutBrainMap'
import { NodeChoiceList, type NodeChoice } from '@/components/brain/NodeChoiceList'
import { inspectorBrainHasFactOrEpisode, inspectorBrainMap } from '@/components/inspector/inspectorBrain'
import type { InspectorTabId } from '@/components/inspector/inspectorTabs'
import type { InspectorTurn } from '@/api/superAgentTypes'

const GRAPH_SIZE = { width: 280, height: 220 }

export function LiveInspector({
  tab,
  turns,
  brain,
  tabListId,
  index,
  onScrub,
  focusIds = [],
}: {
  tab: InspectorTabId
  turns: readonly InspectorTurn[]
  brain: BrainMap
  tabListId: string
  index: number
  onScrub: (index: number) => void
  focusIds?: readonly string[]
}) {
  const turn = turns[index]
  const [selectedId, setSelectedId] = useState<string | null>(focusIds[0] ?? null)
  if (!turn) return null
  const panelId = `${tabListId}-${tab}-panel`
  const tabId = `${tabListId}-${tab}`
  return (
    <div className="maia-inspector-panel" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      {tab === 'cache' ? (
        <LiveCache
          turn={turn}
          turns={turns}
          brain={brain}
          index={index}
          onScrub={onScrub}
          selectedId={selectedId}
          onSelect={setSelectedId}
          focusIds={focusIds}
        />
      ) : null}
      {tab === 'brain' ? (
        <LiveBrain
          turn={turn}
          brain={brain}
          selectedId={selectedId}
          onSelect={setSelectedId}
          focusIds={focusIds}
        />
      ) : null}
      {tab === 'trace' ? (
        <LiveTrace turn={turn} selectedId={selectedId} onSelect={setSelectedId} />
      ) : null}
    </div>
  )
}

export function liveTabCounts(
  turn: InspectorTurn,
  brain: BrainMap,
): Partial<Record<InspectorTabId, string>> {
  const filtered = inspectorBrainMap(brain, recallIds(turn))
  const counts: Partial<Record<InspectorTabId, string>> = {
    brain: String(filtered.nodes.length),
    trace: String(turn.trace.length),
  }
  if (turn.cached_percent !== null) counts.cache = `${turn.cached_percent}%`
  return counts
}

export function selectedIndex(length: number, scrub: number | null): number {
  if (length === 0) return 0
  if (scrub === null) return length - 1
  return Math.min(Math.max(scrub, 0), length - 1)
}

function LiveCache({
  turn,
  turns,
  brain,
  index,
  onScrub,
  selectedId,
  onSelect,
  focusIds,
}: {
  turn: InspectorTurn
  turns: readonly InspectorTurn[]
  brain: BrainMap
  index: number
  onScrub: (index: number) => void
  selectedId: string | null
  onSelect: (id: string) => void
  focusIds: readonly string[]
}) {
  return (
    <>
      {turn.cached_percent === null ? (
        <p className="maia-cache-hero">Cache not reported</p>
      ) : (
        <p className="maia-cache-hero">
          <span className="maia-cache-pct">{turn.cached_percent}%</span>
          <span>cached</span>
        </p>
      )}
      <div className="maia-byte-stack" aria-hidden="true">
        {turn.slots.map((slot) => (
          <i key={slot.ordinal} style={{ flexGrow: Math.max(slot.bytes, 1) }} />
        ))}
      </div>
      <span className="maia-inspector-label">Router prompt slots · in order</span>
      <ol className="maia-slots">
        {turn.slots.map((slot) => (
          <li key={slot.ordinal} data-testid={`inspector-live-slot-${slot.ordinal}`}>
            <span className="maia-slot-n">{slot.ordinal}</span>
            <span>
              {slot.label}
              <span className="maia-slot-state">
                {' '}
                · {slot.bytes} B · {slot.residence} · {slot.detail}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <span className="maia-inspector-label">Recall · not durable</span>
      <NodeChoiceList
        label="Facts used"
        selectedId={selectedId}
        onSelect={onSelect}
        items={recallChoices(turn, brain, focusIds)}
      />
      <div className="maia-scrub">
        <div className="maia-scrub-head">
          <span>
            Router turn {turn.ordinal} of {turns.length}
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={turns.length}
          step={1}
          value={index + 1}
          aria-label="Turn scrubber"
          onChange={(event) => onScrub(Number(event.target.value) - 1)}
        />
      </div>
    </>
  )
}

function LiveBrain({
  turn,
  brain,
  selectedId,
  onSelect,
  focusIds,
}: {
  turn: InspectorTurn
  brain: BrainMap
  selectedId: string | null
  onSelect: (id: string) => void
  focusIds: readonly string[]
}) {
  const ids = focusIds.length > 0 ? new Set(focusIds) : recallIds(turn)
  const filtered = inspectorBrainMap(brain, ids)
  if (!inspectorBrainHasFactOrEpisode(filtered)) {
    return <p>Nothing has been promoted yet. Episodes remain searchable.</p>
  }
  const points = layoutBrainMap(filtered.nodes, filtered.edges, GRAPH_SIZE)
  return (
    <>
    <svg
      className="maia-inspector-graph"
      viewBox={`0 0 ${GRAPH_SIZE.width} ${GRAPH_SIZE.height}`}
      role="img"
      aria-label="Router brain"
    >
      {filtered.edges.map((edge) => {
        const from = points.get(edge.from_id)
        const to = points.get(edge.to_id)
        if (!from || !to) return null
        return (
          <line
            key={`${edge.from_id}-${edge.to_id}-${edge.kind}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        )
      })}
      {filtered.nodes.map((node) => {
        const point = points.get(node.id)
        if (!point) return null
        return (
          <g key={node.id}>
            <circle cx={point.x} cy={point.y} r={8} />
          </g>
        )
      })}
    </svg>
    <NodeChoiceList
      label="Brain nodes"
      selectedId={selectedId}
      onSelect={onSelect}
      items={filtered.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        taint: node.taint,
      }))}
    />
    </>
  )
}

function LiveTrace({
  turn,
  selectedId,
  onSelect,
}: {
  turn: InspectorTurn
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  return (
    <NodeChoiceList
      label="Trace steps"
      selectedId={selectedId}
      onSelect={onSelect}
      items={turn.trace.map((step, index) => ({
        id: `${step.kind}-${index}`,
        label: step.text,
        detail: step.kind === 'route' ? 'admitted by host' : traceLabel(step.kind),
      }))}
    />
  )
}

function traceLabel(kind: InspectorTurn['trace'][number]['kind']): string {
  if (kind === 'reasoning') return 'Reasoning'
  if (kind === 'route') return 'Route'
  return 'Reply'
}

export function recallTaintText(
  taint: 'trusted' | 'untrusted' | null | undefined,
): 'Trusted' | 'Untrusted' | null {
  if (taint === 'trusted') return 'Trusted'
  if (taint === 'untrusted') return 'Untrusted'
  return null
}

function recallIds(turn: InspectorTurn): Set<string> {
  return new Set(turn.recall.map((item) => item.id))
}

function recallChoices(
  turn: InspectorTurn,
  brain: BrainMap,
  focusIds: readonly string[],
): NodeChoice[] {
  const focus = new Set(focusIds)
  return turn.recall
    .filter((item) => focus.size === 0 || focus.has(item.id))
    .map((item) => ({
      id: item.id,
      label: item.sentence,
      taint: item.taint ?? brain.nodes.find((node) => node.id === item.id)?.taint ?? null,
    }))
}
