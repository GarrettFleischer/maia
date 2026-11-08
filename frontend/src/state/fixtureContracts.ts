import type {
  ActionMatcher,
  CapabilityKind,
  GrantId,
  PendingCapabilityApprovalDto,
} from '@/api/types'

export type InspectorTab = 'cache' | 'brain' | 'trace'

export interface InspectorCacheSlotFixture {
  id: string
  label: string
  kind: 'fixed' | 'memory' | 'recall'
}

export interface InspectorFixtureData {
  turn: number
  cached_percent: number
  cache_slots: InspectorCacheSlotFixture[]
  brain_nodes: { id: string; label: string }[]
  trace_steps: { id: string; label: string; match: 'full' | 'half' | 'rejected' }[]
}

export interface AllowlistEntryPatch {
  id: GrantId
  label: string
  matcher: ActionMatcher
  enabled: boolean
}

export interface StopAllPayload {
  at: string
}

export interface ApprovalResolutionPayload {
  approval_id: string
  at: string
}

export function formatAllowlistMatcher(matcher: ActionMatcher): string {
  if (matcher.kind === 'command') {
    return `${matcher.executable} ${matcher.args.join(' ')}`.trim()
  }
  return `${matcher.host}${matcher.path_prefix}`
}

export function buildExactAllowlistFromApproval(
  pending: PendingCapabilityApprovalDto,
  created_by: string,
  created_at: string,
): {
  id: GrantId
  capability: CapabilityKind
  matcher: ActionMatcher
  agent: null
  lifetime: { kind: 'permanent' }
  enabled: boolean
  created_at: string
  created_by: string
  label: string
} {
  return {
    id: `grant-from-${pending.approval_id}`,
    capability: pending.capability,
    matcher: pending.matcher,
    agent: null,
    lifetime: { kind: 'permanent' },
    enabled: true,
    created_at,
    created_by,
    label: pending.target_label,
  }
}
