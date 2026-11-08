# Layouts

The app is one shell, not a URL router. `AppShell` picks phone (<728), tablet (<1100), or desktop from `window.innerWidth`. Desktop and tablet show `AgentRail`. Phone hides the rail and uses `AgentPhoneDrawer` plus a header. The center pane is `ConversationPane` or `SecuritySettingsPage`. Desktop docks `InspectorPanel`; narrower widths use a drawer.

### `frontend/src/components/shell/AppShell.tsx`

```tsx
import { useEffect, useState } from 'react'
import { OnboardingView } from '@/components/onboarding/OnboardingView'
import { InspectorPanel } from '@/components/inspector/InspectorPanel'
import { UnrestrictedBanner } from '@/components/security/UnrestrictedBanner'
import { AgentPhoneDrawer } from '@/components/shell/AgentPhoneDrawer'
import { AgentRail } from '@/components/shell/AgentRail'
import { ConversationPane, type ConversationLayout } from '@/components/shell/ConversationPane'
import { SecuritySettingsPage } from '@/components/settings/SecuritySettingsPage'
import { useMaiaState } from '@/hooks/useMaiaState'
import { toggleCenterView } from '@/state/centerView'

type CenterView = 'conversation' | 'settings'

function useViewportClass(): ConversationLayout | 'desktop' {
  const [kind, setKind] = useState<ConversationLayout | 'desktop'>('desktop')

  useEffect(() => {
    const update = () => {
      const width = window.innerWidth
      if (width < 728) {
        setKind('phone')
      } else if (width < 1100) {
        setKind('tablet')
      } else {
        setKind('desktop')
      }
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return kind
}

export function AppShell() {
  const { state } = useMaiaState()
  const viewport = useViewportClass()
  const [centerView, setCenterView] = useState<CenterView>('conversation')
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [agentsDrawerOpen, setAgentsDrawerOpen] = useState(false)

  if (!state.onboarding_complete) {
    return <OnboardingView />
  }

  const showDesktopRail = viewport !== 'phone'
  const conversationLayout: ConversationLayout =
    viewport === 'desktop' ? 'desktop' : viewport === 'tablet' ? 'tablet' : 'phone'

  const shellClass =
    viewport === 'phone'
      ? 'maia-shell maia-shell--phone'
      : viewport === 'tablet'
        ? 'maia-shell maia-shell--tablet'
        : 'maia-shell'

  return (
    <div className={shellClass} data-viewport={viewport} data-testid="app-shell">
      <UnrestrictedBanner />
      {showDesktopRail ? (
        <AgentRail
          onOpenSettings={() => setCenterView((view) => toggleCenterView(view))}
          settingsActive={centerView === 'settings'}
        />
      ) : (
        <header
          className="maia-phone-header"
          style={{
            gridColumn: '1 / -1',
            display: 'flex',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <button
            type="button"
            className="maia-btn"
            aria-label="Open agents drawer"
            aria-expanded={agentsDrawerOpen}
            onClick={() => setAgentsDrawerOpen(true)}
          >
            Agents
          </button>
          <strong>Scout</strong>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="maia-btn" onClick={() => setInspectorOpen(true)}>
              Inspect
            </button>
            <button
              type="button"
              className="maia-btn"
              onClick={() => setCenterView((view) => toggleCenterView(view))}
              aria-current={centerView === 'settings'}
            >
              Settings
            </button>
          </div>
        </header>
      )}
      <main className="maia-main" id="main-content">
        {centerView === 'settings' ? (
          <div className="maia-main-body">
            <h1>Settings</h1>
            <SecuritySettingsPage />
          </div>
        ) : (
          <ConversationPane layout={conversationLayout} />
        )}
      </main>
      {viewport === 'desktop' ? (
        <InspectorPanel surface="docked" open data={state.inspector} onClose={() => undefined} />
      ) : (
        <InspectorPanel
          surface="drawer"
          open={inspectorOpen}
          onClose={() => setInspectorOpen(false)}
          data={state.inspector}
        />
      )}
      {!showDesktopRail ? (
        <>
          <AgentPhoneDrawer
            open={agentsDrawerOpen}
            onClose={() => setAgentsDrawerOpen(false)}
            onOpenSettings={() => setCenterView('settings')}
          />
        </>
      ) : viewport === 'tablet' ? (
        <button
          type="button"
          className="maia-btn"
          style={{ position: 'fixed', top: 12, right: 12, zIndex: 20 }}
          onClick={() => setInspectorOpen(true)}
        >
          Inspect
        </button>
      ) : null}
    </div>
  )
}

```

### `frontend/src/components/shell/AgentRail.tsx`

```tsx
import { useMaiaState } from '@/hooks/useMaiaState'
import { StopAllButton } from '@/components/shell/StopAllButton'

export function AgentRail({
  onOpenSettings,
  settingsActive,
}: {
  onOpenSettings: () => void
  settingsActive: boolean
}) {
  const { state } = useMaiaState()
  const { running, needs_human: needsHuman } = state.activity

  return (
    <nav className="maia-nav" aria-label="Agents">
      <div className="maia-nav-scroll">
        <strong>Maia</strong>
        <p style={{ color: 'var(--muted)' }}>Agents</p>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          <li>
            <span aria-current="page">Scout · with you</span>
          </li>
        </ul>
        <section aria-label="Activity">
          <p data-testid="activity-counts">
            {running} running · {needsHuman} needs you
          </p>
        </section>
      </div>
      <div className="maia-nav-footer">
        <StopAllButton />
        <button type="button" className="maia-btn" onClick={onOpenSettings} aria-current={settingsActive}>
          Settings
        </button>
      </div>
    </nav>
  )
}

export function AgentRailBody() {
  const { state } = useMaiaState()
  const { running, needs_human: needsHuman } = state.activity
  return (
    <>
      <strong>Maia</strong>
      <p style={{ color: 'var(--muted)' }}>Agents</p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        <li>
          <span aria-current="page">Scout · with you</span>
        </li>
      </ul>
      <section aria-label="Activity">
        <p data-testid="activity-counts">
          {running} running · {needsHuman} needs you
        </p>
      </section>
    </>
  )
}

```

### `frontend/src/components/shell/ConversationPane.tsx`

```tsx
import { useState } from 'react'
import { ApprovalSheet } from '@/components/approval/ApprovalSheet'
import { NeedsHumanBanner } from '@/components/conversation/NeedsHumanBanner'
import { StopAllButton } from '@/components/shell/StopAllButton'
import { useMaiaState } from '@/hooks/useMaiaState'

export type ConversationLayout = 'desktop' | 'tablet' | 'phone'

export function ConversationPane({ layout }: { layout: ConversationLayout }) {
  const { state, dispatch } = useMaiaState()
  const [approvalOpen, setApprovalOpen] = useState(false)
  const pending = state.pending_approval
  const composerDisabled = pending !== null

  const denyPending = () => {
    if (!pending) {
      return
    }
    dispatch({
      type: 'approval_deny',
      approval_id: pending.approval_id,
      at: new Date().toISOString(),
    })
    setApprovalOpen(false)
  }

  return (
    <section className="maia-conversation" aria-label="Conversation">
      <header style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <h1 style={{ fontSize: 15, margin: 0 }}>Scout · with you</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>budget 12.4k / 30k</p>
      </header>

      <NeedsHumanBanner onApprove={() => setApprovalOpen(true)} onDeny={denyPending} />

      <div className="maia-transcript" data-testid="transcript">
        <p>
          <strong>You</strong>
        </p>
        <p>Can I open this from my phone?</p>
        <p>
          <strong>Scout</strong>
        </p>
        <p>Yes. Same UI over Tailscale.</p>
      </div>

      {layout === 'phone' && state.activity.running > 0 ? (
        <div className="maia-phone-stop" data-testid="phone-stop-bar">
          <span>{state.activity.running} running</span>
          <StopAllButton />
        </div>
      ) : null}

      <div className="maia-composer" data-testid="composer">
        <label htmlFor="composer-input" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer-input"
          placeholder="Message"
          defaultValue=""
          disabled={composerDisabled}
          aria-disabled={composerDisabled}
        />
        <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="maia-btn maia-btn--primary" disabled={composerDisabled}>
            Send
          </button>
        </div>
      </div>

      {pending ? (
        <ApprovalSheet
          open={approvalOpen}
          capability={pending.capability}
          targetLabel={pending.target_label}
          digest={pending.digest}
          onAllowOnce={() => {
            dispatch({
              type: 'approval_allow_once',
              approval_id: pending.approval_id,
              at: new Date().toISOString(),
            })
            setApprovalOpen(false)
          }}
          onAlwaysAllowExact={() => {
            dispatch({
              type: 'approval_always_allow_exact',
              approval_id: pending.approval_id,
              at: new Date().toISOString(),
              created_by: state.security.activated_by,
            })
            setApprovalOpen(false)
          }}
          onDeny={denyPending}
          onClose={() => setApprovalOpen(false)}
        />
      ) : null}
    </section>
  )
}

```

### `frontend/src/components/shell/AgentPhoneDrawer.tsx`

```tsx
import { FocusTrap } from '@/components/a11y/FocusTrap'
import { AgentRailBody } from '@/components/shell/AgentRail'
import { StopAllButton } from '@/components/shell/StopAllButton'

export function AgentPhoneDrawer({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean
  onClose: () => void
  onOpenSettings: () => void
}) {
  return (
    <FocusTrap active={open} onClose={onClose} labelId="agents-drawer-title">
      <nav aria-label="Agents">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 id="agents-drawer-title" style={{ margin: 0, fontSize: 15 }}>
            Agents
          </h2>
          <button type="button" className="maia-btn" onClick={onClose}>
            Close
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <AgentRailBody />
        </div>
        <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
          <StopAllButton />
          <button
            type="button"
            className="maia-btn"
            onClick={() => {
              onOpenSettings()
              onClose()
            }}
          >
            Settings
          </button>
        </div>
      </nav>
    </FocusTrap>
  )
}

```

### `frontend/src/components/inspector/InspectorPanel.tsx`

```tsx
import { useId, useState } from 'react'
import type { InspectorFixtureDto } from '@/api/types'
import { FocusTrap } from '@/components/a11y/FocusTrap'

export type InspectorSurface = 'docked' | 'drawer'

export type InspectorTabId = 'cache' | 'brain' | 'trace'

function InspectorTabs({
  activeTab,
  onTabChange,
  tabListId,
}: {
  activeTab: InspectorTabId
  onTabChange: (tab: InspectorTabId) => void
  tabListId: string
}) {
  const tabs: InspectorTabId[] = ['cache', 'brain', 'trace']
  return (
    <div role="tablist" aria-label="Inspector views" id={tabListId} className="maia-inspector-tabs">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${tabListId}-${tab}`}
          aria-selected={activeTab === tab}
          aria-controls={`${tabListId}-${tab}-panel`}
          onClick={() => onTabChange(tab)}
        >
          {tab.charAt(0).toUpperCase() + tab.slice(1)}
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
      <div role="tabpanel" id={panelId} aria-labelledby={tabId}>
        <p className="maia-mono">
          turn {data.turn} · {data.cached_percent}% cached
        </p>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.cache_slots.map((slot) => (
            <li key={slot.id} data-testid={`inspector-cache-slot-${slot.id}`}>
              {slot.label} · {slot.section}
            </li>
          ))}
        </ul>
      </div>
    )
  }
  if (tab === 'brain') {
    return (
      <div role="tabpanel" id={panelId} aria-labelledby={tabId}>
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
    <div role="tabpanel" id={panelId} aria-labelledby={tabId}>
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
}: {
  surface: InspectorSurface
  open: boolean
  onClose: () => void
  data: InspectorFixtureDto
}) {
  const [activeTab, setActiveTab] = useState<InspectorTabId>('cache')
  const tabListId = useId()

  const body = (
    <>
      <InspectorTabs activeTab={activeTab} onTabChange={setActiveTab} tabListId={tabListId} />
      <InspectorTabPanel tab={activeTab} data={data} tabListId={tabListId} />
    </>
  )

  if (surface === 'docked') {
    return (
      <aside className="maia-inspector" aria-label="Inspector">
        <div style={{ padding: 12 }}>{body}</div>
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

```

