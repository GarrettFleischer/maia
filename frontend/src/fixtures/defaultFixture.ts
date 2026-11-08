import type { MaiaFixtureState } from '@/api/types'
import { defaultInspectorFixture } from '@/fixtures/inspectorFixture'

export const FIXTURE_STORAGE_KEY = 'maia.fixture.v1'

export const defaultFixtureState = (): MaiaFixtureState => ({
  onboarding_complete: false,
  client_class: 'local_desktop',
  security: {
    profile: 'protected',
    activated_at: '2026-11-05T00:00:00Z',
    activated_by: 'owner-desktop-1',
    local_unrestricted_confirmation: null,
  },
  capabilities: {
    platform: 'windows',
    observed_at: '2026-11-05T00:00:00Z',
    adapter_version: '0.0.0-fixture',
    overall_verdict: 'unattended_ready',
    probes: [
      { name: 'appcontainer', passed: true, safe_reason: null },
      { name: 'job_object', passed: true, safe_reason: null },
    ],
    kernel_version: null,
    landlock_abi: null,
  },
  allowlist: [
    {
      id: 'grant-1',
      capability: 'shell',
      matcher: {
        kind: 'command',
        platform: 'windows',
        executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-File', 'build.ps1'],
      },
      agent: null,
      lifetime: { kind: 'permanent' },
      enabled: true,
      created_at: '2026-11-04T12:00:00Z',
      created_by: 'owner-desktop-1',
      label: 'pwsh -File build.ps1',
    },
    {
      id: 'grant-2',
      capability: 'web',
      matcher: {
        kind: 'web',
        host: 'api.example.com',
        path_prefix: '/v1/',
      },
      agent: 'agent-scout',
      lifetime: { kind: 'expires_at', expires_at: '2027-01-01T00:00:00Z' },
      enabled: false,
      created_at: '2026-11-03T08:00:00Z',
      created_by: 'owner-phone-1',
      label: 'api.example.com/v1/',
    },
  ],
  credential_backend: {
    active_backend: 'native',
    encrypted_file_idle_timeout_minutes: 15,
    native_store_label: 'Windows Credential Manager',
  },
  encrypted_file_lock_state: 'unlocked',
  activity: { running: 2, needs_human: 1 },
  audit: {
    chain_status: 'verified',
    last_verified_at: '2026-11-05T00:00:00Z',
  },
  panic_latch: { engaged: false, engaged_at: null },
  pending_approval: {
    approval_id: 'approval-cap-1',
    capability: 'shell',
    target_label: 'pwsh -File build.ps1',
    digest: 'ab12cd34',
    matcher: {
      kind: 'command',
      platform: 'windows',
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: ['-File', 'build.ps1'],
    },
  },
  inspector: defaultInspectorFixture(),
})

export const remoteClientFixture = (): MaiaFixtureState => ({
  ...defaultFixtureState(),
  onboarding_complete: true,
  client_class: 'remote_owner',
})

export function normalizeFixtureState(partial: Partial<MaiaFixtureState> | MaiaFixtureState): MaiaFixtureState {
  const defaults = defaultFixtureState()
  return {
    ...defaults,
    ...partial,
    security: { ...defaults.security, ...partial.security },
    activity: { ...defaults.activity, ...partial.activity },
    panic_latch: partial.panic_latch ?? defaults.panic_latch,
    pending_approval:
      partial.pending_approval === undefined ? defaults.pending_approval : partial.pending_approval,
    inspector: partial.inspector ?? defaults.inspector,
    allowlist: partial.allowlist ?? defaults.allowlist,
  }
}
