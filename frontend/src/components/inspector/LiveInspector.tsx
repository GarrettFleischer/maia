import { layoutBrainMap, type BrainMap } from '@/components/brain/layoutBrainMap'
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
}: {
  tab: InspectorTabId
  turns: readonly InspectorTurn[]
  brain: BrainMap
  tabListId: string
  index: number
  onScrub: (index: number) => void
}) {
  const turn = turns[index]
  if (!turn) return null
  const panelId = `${tabListId}-${tab}-panel`
  const tabId = `${tabListId}-${tab}`
  return (
    <div className="maia-inspector-panel" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      {tab === 'cache' ? <LiveCache turn={turn} turns={turns} index={index} onScrub={onScrub} /> : null}
      {tab === 'brain' ? <LiveBrain turn={turn} brain={brain} /> : null}
      {tab === 'trace' ? <LiveTrace turn={turn} /> : null}
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
  index,
  onScrub,
}: {
  turn: InspectorTurn
  turns: readonly InspectorTurn[]
  index: number
  onScrub: (index: number) => void
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
      <ul className="maia-recall">
        {turn.recall.map((item) => (
          <li key={item.id}>
            <span>{item.sentence}</span>
            <span className="maia-slot-state">{item.score.toFixed(2)}</span>
          </li>
        ))}
      </ul>
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

function LiveBrain({ turn, brain }: { turn: InspectorTurn; brain: BrainMap }) {
  const filtered = inspectorBrainMap(brain, recallIds(turn))
  if (!inspectorBrainHasFactOrEpisode(filtered)) {
    return <p>No facts in the brain yet.</p>
  }
  const points = layoutBrainMap(filtered.nodes, filtered.edges, GRAPH_SIZE)
  return (
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
            <text x={point.x} y={point.y + 18} textAnchor="middle">
              {node.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function LiveTrace({ turn }: { turn: InspectorTurn }) {
  return (
    <ol className="maia-trace">
      {turn.trace.map((step) => (
        <li key={step.kind}>
          <span className="maia-inspector-label">{traceLabel(step.kind)}</span>
          {step.kind === 'route' ? <span className="maia-slot-state">admitted by host</span> : null}
          <p>{step.text}</p>
        </li>
      ))}
    </ol>
  )
}

function traceLabel(kind: InspectorTurn['trace'][number]['kind']): string {
  if (kind === 'reasoning') return 'Reasoning'
  if (kind === 'route') return 'Route'
  return 'Reply'
}

function recallIds(turn: InspectorTurn): Set<string> {
  return new Set(turn.recall.map((item) => item.id))
}
