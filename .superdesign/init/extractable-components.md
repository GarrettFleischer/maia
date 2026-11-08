# Extractable components

## AppShell
- Source: `frontend/src/components/shell/AppShell.tsx`
- Category: layout
- Description: Viewport shell with rail or phone header, center pane, and inspector
- Extractable props: centerView (conversation | settings), viewport (phone | tablet | desktop), inspectorOpen (boolean)
- Hardcoded: Mint Ledger grid classes, Settings / Agents / Inspect labels

## AgentRail
- Source: `frontend/src/components/shell/AgentRail.tsx`
- Category: layout
- Description: Left rail with the agent list, activity counts, Stop all, and Settings
- Extractable props: settingsActive (boolean)
- Hardcoded: "Maia", "Agents", Scout row, Stop all label, activity sentence

## ConversationPane
- Source: `frontend/src/components/shell/ConversationPane.tsx`
- Category: layout
- Description: Transcript, needs-human banner, phone stop bar, and the only composer
- Extractable props: layout (desktop | tablet | phone)
- Hardcoded: "Scout · with you", sample transcript, Message label, Send button

## AgentPhoneDrawer
- Source: `frontend/src/components/shell/AgentPhoneDrawer.tsx`
- Category: layout
- Description: Focus-trapped phone drawer for the rail body, Stop all, and Settings
- Extractable props: open (boolean)
- Hardcoded: title "Agents", Close, Settings

## InspectorPanel
- Source: `frontend/src/components/inspector/InspectorPanel.tsx`
- Category: layout
- Description: Docked or drawer inspector with Cache, Brain, and Trace tabs
- Extractable props: surface (docked | drawer), open (boolean), active tab
- Hardcoded: tab labels, inspector padding

## FocusTrap
- Source: `frontend/src/components/a11y/FocusTrap.tsx`
- Category: basic
- Description: Modal focus trap with Escape to close
- Extractable props: active (boolean), labelId (string)
- Hardcoded: dialog width, backdrop, focusable selector

## StopAllButton
- Source: `frontend/src/components/shell/StopAllButton.tsx`
- Category: basic
- Description: Danger button that dispatches stop_all
- Extractable props: className (string)
- Hardcoded: aria-label "Stop all running threads", text "Stop all"

## NeedsHumanBanner
- Source: `frontend/src/components/conversation/NeedsHumanBanner.tsx`
- Category: basic
- Description: Warning banner for a pending approval
- Extractable props: capability, target label, digest from state
- Hardcoded: "Needs you", Approve, Deny

## ApprovalSheet
- Source: `frontend/src/components/approval/ApprovalSheet.tsx`
- Category: basic
- Description: Modal approval for one pending capability
- Extractable props: open (boolean), capability, targetLabel, digest
- Hardcoded: Allow once, Always allow this exact action, Deny

## UnrestrictedBanner
- Source: `frontend/src/components/security/UnrestrictedBanner.tsx`
- Category: basic
- Description: Status banner when the unrestricted profile is active
- Extractable props: none; visibility comes from state
- Hardcoded: Unrestricted copy, Return to Protected

## SecurityProfileCards
- Source: `frontend/src/components/settings/SecurityProfileCards.tsx`
- Category: basic
- Description: Protected, Allowlisted, and Unrestricted profile choices
- Extractable props: active profile, onRequestUnrestricted
- Hardcoded: profile titles and bodies, card grid
