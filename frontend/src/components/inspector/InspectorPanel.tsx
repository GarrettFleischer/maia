import { useId, useState } from 'react'
import type { InspectorTurn } from '@/api/superAgentTypes'
import type { InspectorFixtureDto } from '@/api/types'
import { FocusTrap } from '@/components/a11y/FocusTrap'
import type { BrainMap } from '@/components/brain/layoutBrainMap'
import { LiveInspector, liveTabCounts, selectedIndex } from '@/components/inspector/LiveInspector'
import {
  INSPECTOR_TABS,
  nextInspectorTab,
  type InspectorTabId,
} from '@/components/inspector/inspectorTabs'

export type InspectorSurface = 'docked' | 'drawer'

function emptyInspectorText(tab: InspectorTabId): string {
  if (tab === 'cache') return 'No context usage for this turn.'
  if (tab === 'brain') return 'No brain report for this turn.'
  return 'No trace for this turn.'
}

function InspectorTabs({
  activeTab,
  onTabChange,
  tabListId,
  counts,
}: {
  activeTab: InspectorTabId
  onTabChange: (tab: InspectorTabId) => void
  tabListId: string
  counts?: Partial<Record<InspectorTabId, string>>
}) {
  return (
    <div role="tablist" aria-label="Inspector views" id={tabListId} className="maia-inspector-tabs">
      {INSPECTOR_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${tabListId}-${tab}`}
          data-inspector-tab={tab}
          aria-selected={activeTab === tab}
          aria-controls={`${tabListId}-${tab}-panel`}
          tabIndex={activeTab === tab ? 0 : -1}
          onClick={() => onTabChange(tab)}
          onKeyDown={(event) => {
            if (
              event.key !== 'ArrowLeft' &&
              event.key !== 'ArrowRight' &&
              event.key !== 'Home' &&
              event.key !== 'End'
            ) {
              return
            }
            event.preventDefault()
            const next = nextInspectorTab(activeTab, event.key)
            onTabChange(next)
            event.currentTarget.parentElement
              ?.querySelector<HTMLElement>(`[data-inspector-tab="${next}"]`)
              ?.focus()
          }}
        >
          {tab.charAt(0).toUpperCase() + tab.slice(1)}
          {counts?.[tab] ? (
            <span className="maia-tab-count" aria-hidden="true">
              {counts[tab]}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

function InspectorTabPanel({
  tab,
  data,
  tabListId,
}: {
  tab: InspectorTabId
  data: InspectorFixtureDto
  tabListId: string
}) {
  const panelId = `${tabListId}-${tab}-panel`
  const tabId = `${tabListId}-${tab}`
  if (tab === 'cache') {
    return (
      <div className="maia-inspector-panel" role="tabpanel" id={panelId} aria-labelledby={tabId}>
        <p className="maia-mono">
          turn {data.turn} · {data.cached_percent}% cached
        </p>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.cache_slots.map((slot) => (
            <li key={slot.id} data-testid={`inspector-cache-slot-${slot.id}`}>
              {slot.label} · {slot.section}
              {slot.section === 'recall'
                ? ` · ${slot.taint === 'trusted' ? 'Trusted' : 'Untrusted'}`
                : ''}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (tab === 'brain') {
    return (
      <div className="maia-inspector-panel" role="tabpanel" id={panelId} aria-labelledby={tabId}>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.brain_nodes.map((node) => (
            <li key={node.id} data-testid={`inspector-brain-node-${node.id}`}>
              {node.label}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="maia-inspector-panel" role="tabpanel" id={panelId} aria-labelledby={tabId}>
      <ol>
        {data.trace_steps.map((step) => (
          <li key={step.id}>
            {step.label} · {step.match_label}
          </li>
        ))}
      </ol>
    </div>
  )
}

export function InspectorPanel({
  surface,
  open,
  onClose,
  data,
  live,
}: {
  surface: InspectorSurface
  open: boolean
  onClose: () => void
  data?: InspectorFixtureDto
  live?: { turns: readonly InspectorTurn[]; brain: BrainMap; focusIds?: readonly string[] }
}) {
  const [activeTab, setActiveTab] = useState<InspectorTabId>('cache')
  const [scrub, setScrub] = useState<number | null>(null)
  const tabListId = useId()
  const index = live ? selectedIndex(live.turns.length, scrub) : 0
  const turn = live?.turns[index]
  const counts = turn && live ? liveTabCounts(turn, live.brain) : undefined

  const body = (
    <>
      <InspectorTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tabListId={tabListId}
        counts={counts}
      />
      {live && live.turns.length > 0 ? (
        <LiveInspector
          tab={activeTab}
          turns={live.turns}
          brain={live.brain}
          tabListId={tabListId}
          index={index}
          onScrub={setScrub}
          focusIds={live.focusIds}
        />
      ) : data ? (
        <InspectorTabPanel tab={activeTab} data={data} tabListId={tabListId} />
      ) : (
        <div
          className="maia-inspector-panel"
          role="tabpanel"
          id={`${tabListId}-${activeTab}-panel`}
          aria-labelledby={`${tabListId}-${activeTab}`}
        >
          <p>{emptyInspectorText(activeTab)}</p>
        </div>
      )}
    </>
  )

  if (surface === 'docked') {
    return (
      <aside className="maia-inspector" aria-label="Inspector">
        {body}
      </aside>
    )
  }

  if (!open) {
    return null
  }

  return (
    <FocusTrap active={open} onClose={onClose} labelId="inspector-drawer-title">
      <aside className="maia-inspector-drawer" aria-label="Inspector drawer">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="inspector-drawer-title" style={{ margin: 0, fontSize: 15 }}>
            Inspector
          </h2>
          <button type="button" className="maia-btn" onClick={onClose}>
            Close inspector
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{body}</div>
      </aside>
    </FocusTrap>
  )
}
