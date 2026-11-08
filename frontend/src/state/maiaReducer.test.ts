import { describe, expect, it } from 'vitest'
import { defaultFixtureState, remoteClientFixture } from '@/fixtures/defaultFixture'
import {
  canEnableUnrestricted,
  canSelectProfile,
  canTightenToProfile,
  reduceMaiaState,
  selectAllowlistEntries,
  selectUnrestrictedBannerVisible,
} from '@/state/maiaReducer'

describe('security profile reducer', () => {
  it('requires local desktop to enable unrestricted', () => {
    expect(canEnableUnrestricted('local_desktop')).toBe(true)
    expect(canEnableUnrestricted('remote_owner')).toBe(false)
    expect(canSelectProfile('unrestricted', 'remote_owner', 'protected')).toEqual({
      allowed: false,
      reason: 'Change this on the desktop.',
    })
  })

  it('records confirmation when unrestricted is confirmed locally', () => {
    const next = reduceMaiaState(defaultFixtureState(), {
      type: 'confirm_unrestricted',
      confirmed_at: '2026-11-05T10:00:00Z',
      desktop_client_id: 'owner-desktop-1',
    })
    expect(next.security.profile).toBe('unrestricted')
    expect(next.security.local_unrestricted_confirmation).toEqual({
      confirmed_at: '2026-11-05T10:00:00Z',
      desktop_client_id: 'owner-desktop-1',
    })
    expect(selectUnrestrictedBannerVisible(next)).toBe(true)
  })

  it('ignores unrestricted confirmation from remote clients', () => {
    const remote = remoteClientFixture()
    const unchanged = reduceMaiaState(remote, {
      type: 'confirm_unrestricted',
      confirmed_at: '2026-11-05T10:00:00Z',
      desktop_client_id: 'owner-phone-1',
    })
    expect(unchanged.security.profile).toBe(remote.security.profile)
    expect(selectUnrestrictedBannerVisible(unchanged)).toBe(false)
  })

  it('returns to protected and clears confirmation', () => {
    const unrestricted = reduceMaiaState(defaultFixtureState(), {
      type: 'confirm_unrestricted',
      confirmed_at: '2026-11-05T10:00:00Z',
      desktop_client_id: 'owner-desktop-1',
    })
    const tightened = reduceMaiaState(unrestricted, {
      type: 'return_to_protected',
      at: '2026-11-05T11:00:00Z',
      by: 'owner-phone-1',
    })
    expect(tightened.security.profile).toBe('protected')
    expect(tightened.security.local_unrestricted_confirmation).toBeNull()
    expect(selectUnrestrictedBannerVisible(tightened)).toBe(false)
  })

  it('persists allowlist enabled flags across profile switches', () => {
    const base = defaultFixtureState()
    const disabled = reduceMaiaState(base, {
      type: 'set_allowlist_enabled',
      id: 'grant-1',
      enabled: false,
    })
    const unrestricted = reduceMaiaState(disabled, {
      type: 'confirm_unrestricted',
      confirmed_at: '2026-11-05T10:00:00Z',
      desktop_client_id: 'owner-desktop-1',
    })
    const entry = unrestricted.allowlist.find((e) => e.id === 'grant-1')
    expect(entry?.enabled).toBe(false)
  })

  it('filters allowlist entries by search query', () => {
    const state = defaultFixtureState()
    const results = selectAllowlistEntries(state, 'build.ps1')
    expect(results.map((e) => e.id)).toEqual(['grant-1'])
    expect(selectAllowlistEntries(state, 'api.example')).toHaveLength(1)
  })

  it('allows monotonic tightening from unrestricted', () => {
    expect(canTightenToProfile('unrestricted', 'protected')).toBe(true)
    expect(canTightenToProfile('unrestricted', 'allowlisted')).toBe(true)
    expect(canTightenToProfile('protected', 'unrestricted')).toBe(false)
  })
})

describe('onboarding reducer', () => {
  it('cannot finish without explicit credential backend selection', () => {
    const next = reduceMaiaState(defaultFixtureState(), {
      type: 'complete_onboarding',
      credential_backend: 'encrypted_file',
    })
    expect(next.onboarding_complete).toBe(true)
    expect(next.credential_backend.active_backend).toBe('encrypted_file')
  })
})

describe('stop all latch', () => {
  it('clears running and needs-human activity and engages panic latch', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const next = reduceMaiaState(base, { type: 'stop_all', at: '2026-11-05T12:00:00Z' })
    expect(next.activity).toEqual({ running: 0, needs_human: 0 })
    expect(next.panic_latch).toEqual({ engaged: true, engaged_at: '2026-11-05T12:00:00Z' })
    expect(next.pending_approval).toBeNull()
  })
})

describe('capability approval fixture flow', () => {
  it('clears pending approval on allow once', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const next = reduceMaiaState(base, {
      type: 'approval_allow_once',
      approval_id: 'approval-cap-1',
      at: '2026-11-05T12:00:00Z',
    })
    expect(next.pending_approval).toBeNull()
    expect(next.activity.needs_human).toBe(0)
  })

  it('upserts matching shell grant instead of duplicating seeded entry', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const next = reduceMaiaState(base, {
      type: 'approval_always_allow_exact',
      approval_id: 'approval-cap-1',
      at: '2026-11-05T12:00:00Z',
      created_by: 'owner-desktop-1',
    })
    expect(next.allowlist).toHaveLength(2)
    const shellEntries = next.allowlist.filter((entry) => entry.capability === 'shell')
    expect(shellEntries).toHaveLength(1)
    expect(shellEntries[0]?.id).toBe('grant-1')
    expect(shellEntries[0]?.enabled).toBe(true)
  })

  it('keeps distinct scopes when matcher differs', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const withDistinctPending = {
      ...base,
      pending_approval: {
        approval_id: 'approval-web-2',
        capability: 'web' as const,
        target_label: 'other.example.com/',
        digest: 'ff00aa11',
        matcher: { kind: 'web' as const, host: 'other.example.com', path_prefix: '/' },
      },
    }
    const next = reduceMaiaState(withDistinctPending, {
      type: 'approval_always_allow_exact',
      approval_id: 'approval-web-2',
      at: '2026-11-05T12:00:00Z',
      created_by: 'owner-desktop-1',
    })
    expect(next.allowlist).toHaveLength(3)
  })

  it('clears pending approval on deny', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const next = reduceMaiaState(base, {
      type: 'approval_deny',
      approval_id: 'approval-cap-1',
      at: '2026-11-05T12:00:00Z',
    })
    expect(next.pending_approval).toBeNull()
    expect(next.activity.needs_human).toBe(0)
  })
})

describe('allowlist edit', () => {
  it('updates structured matcher and label for an entry', () => {
    const base = { ...defaultFixtureState(), onboarding_complete: true }
    const next = reduceMaiaState(base, {
      type: 'update_allowlist_entry',
      id: 'grant-2',
      label: 'api.example.com/v2/',
      matcher: { kind: 'web', host: 'api.example.com', path_prefix: '/v2/' },
      enabled: true,
    })
    const entry = next.allowlist.find((row) => row.id === 'grant-2')
    expect(entry?.label).toBe('api.example.com/v2/')
    expect(entry?.matcher).toEqual({ kind: 'web', host: 'api.example.com', path_prefix: '/v2/' })
    expect(entry?.enabled).toBe(true)
  })
})
