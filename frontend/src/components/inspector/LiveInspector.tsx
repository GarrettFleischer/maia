import { useState } from 'react'
import type { BrainMap } from '@/components/brain/layoutBrainMap'
import { NodeChoiceList, type NodeChoice } from '@/components/brain/NodeChoiceList'
import type { InspectorTabId } from '@/components/inspector/inspectorTabs'
import type { InspectorTurn } from '@/api/superAgentTypes'

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

export function liveTabCounts(turn: InspectorTurn): Partial<Record<InspectorTabId, string>> {
  const counts: Partial<Record<InspectorTabId, string>> = { trace: String(turn.trace.length) }
  if (turn.recall.length > 0) counts.brain = String(turn.recall.length)
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
        <p className="maia-cache-hero">No cache info for this reply</p>
      ) : (
        <p className="maia-cache-hero">
          <span className="maia-cache-pct">{turn.cached_percent}%</span>
          <span>reused from cache</span>
        </p>
      )}
      <details>
        <summary className="maia-inspector-label">What Maia read</summary>
        <ol className="maia-slots">
          {turn.slots.map((slot) => (
            <li key={slot.ordinal} data-testid={`inspector-live-slot-${slot.ordinal}`}>
              <span className="maia-slot-n">{slot.ordinal}</span>
              <span>
                {slotName(slot.label)}
                <span className="maia-slot-state"> · {sizeText(slot.bytes)}</span>
              </span>
            </li>
          ))}
        </ol>
      </details>
      {turn.recall.length > 0 ? <span className="maia-inspector-label">Memories used</span> : null}
      <NodeChoiceList
        label="Facts used"
        selectedId={selectedId}
        onSelect={onSelect}
        items={recallChoices(turn, brain, focusIds)}
      />
      <div className="maia-scrub">
        <div className="maia-scrub-head">
          <span>
            Reply {turn.ordinal} of {turns.length}
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
  const items = recallChoices(turn, brain, focusIds)
  if (items.length === 0) return <p>No memories were used for this reply.</p>
  return (
    <NodeChoiceList
      label="Memories used"
      selectedId={selectedId}
      onSelect={onSelect}
      items={items}
    />
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
        detail: traceLabel(step.kind),
      }))}
    />
  )
}

function traceLabel(kind: InspectorTurn['trace'][number]['kind']): string {
  if (kind === 'reasoning') return 'Reasoning'
  if (kind === 'route') return 'Action'
  return 'Reply'
}

export function recallTaintText(
  taint: 'trusted' | 'untrusted' | null | undefined,
): 'Trusted' | 'Untrusted' | null {
  if (taint === 'trusted') return 'Trusted'
  if (taint === 'untrusted') return 'Untrusted'
  return null
}

const SLOT_NAMES: Record<string, string> = {
  'Route tools': 'Tools',
  'Router instructions': 'Instructions',
  'Candidate tasks': 'Open tasks',
  Recall: 'Memories',
}

function slotName(label: string): string {
  return SLOT_NAMES[label] ?? label
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`
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
