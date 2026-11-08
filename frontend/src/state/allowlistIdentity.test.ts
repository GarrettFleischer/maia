import { describe, expect, it } from 'vitest'
import { allowlistLogicalKey, upsertExactAllowlistEntry } from '@/state/allowlistIdentity'
import { defaultFixtureState } from '@/fixtures/defaultFixture'

describe('allowlistLogicalKey', () => {
  it('treats identical structured matchers as the same logical grant', () => {
    const base = defaultFixtureState().allowlist[0]
    const duplicate = {
      ...base,
      id: 'grant-from-approval-cap-1',
      label: 'duplicate label',
    }
    expect(allowlistLogicalKey(base)).toBe(allowlistLogicalKey(duplicate))
  })

  it('keeps different web hosts as distinct scopes', () => {
    const web = defaultFixtureState().allowlist[1]
    const other = {
      ...web,
      matcher: { kind: 'web' as const, host: 'other.example.com', path_prefix: '/v1/' },
    }
    expect(allowlistLogicalKey(web)).not.toBe(allowlistLogicalKey(other))
  })
})

describe('upsertExactAllowlistEntry', () => {
  it('replaces an existing logical duplicate instead of appending', () => {
    const entries = defaultFixtureState().allowlist
    const candidate = {
      ...entries[0],
      id: 'grant-from-approval-cap-1',
      enabled: true,
      label: 'pwsh -File build.ps1',
    }
    const next = upsertExactAllowlistEntry(entries, candidate)
    expect(next).toHaveLength(2)
    const shellEntries = next.filter((entry) => entry.capability === 'shell')
    expect(shellEntries).toHaveLength(1)
    expect(shellEntries[0]?.id).toBe('grant-1')
  })
})
