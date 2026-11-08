# Page dependency trees

## / conversation shell
Entry: frontend/src/main.tsx
Dependencies:
- frontend/src/styles/mint-ledger.css
- frontend/src/App.tsx
  - frontend/src/hooks/useMaiaState.tsx
    - frontend/src/api/types.ts
    - frontend/src/fixtures/defaultFixture.ts
      - frontend/src/fixtures/inspectorFixture.ts
    - frontend/src/state/maiaReducer.ts
      - frontend/src/state/allowlistIdentity.ts
  - frontend/src/components/shell/AppShell.tsx
    - frontend/src/state/centerView.ts
    - frontend/src/components/onboarding/OnboardingView.tsx
      - frontend/src/components/settings/SecurityProfileCards.tsx
      - frontend/src/components/security/UnrestrictedConfirmDialog.tsx
        - frontend/src/components/a11y/FocusTrap.tsx
    - frontend/src/components/inspector/InspectorPanel.tsx
      - frontend/src/components/a11y/FocusTrap.tsx
    - frontend/src/components/security/UnrestrictedBanner.tsx
    - frontend/src/components/shell/AgentPhoneDrawer.tsx
      - frontend/src/components/a11y/FocusTrap.tsx
      - frontend/src/components/shell/AgentRail.tsx
      - frontend/src/components/shell/StopAllButton.tsx
        - frontend/src/hooks/useStopAllAction.ts
    - frontend/src/components/shell/ConversationPane.tsx
      - frontend/src/components/approval/ApprovalSheet.tsx
        - frontend/src/state/fixtureContracts.ts
      - frontend/src/components/conversation/NeedsHumanBanner.tsx
      - frontend/src/components/shell/StopAllButton.tsx
    - frontend/src/components/settings/SecuritySettingsPage.tsx
      - frontend/src/components/settings/AllowlistPanel.tsx
      - frontend/src/components/settings/CapabilityReportView.tsx
      - frontend/src/components/settings/CredentialBackendSelector.tsx
      - frontend/src/components/settings/SecurityProfileCards.tsx
      - frontend/src/components/security/UnrestrictedConfirmDialog.tsx

## / settings center
Same shell. `centerView === 'settings'` swaps `ConversationPane` for `SecuritySettingsPage`.

## / onboarding
`AppShell` returns `OnboardingView` before the shell grid when onboarding is incomplete.
