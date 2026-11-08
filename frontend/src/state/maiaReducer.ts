import type {
  ActionMatcher,
  ClientClass,
  MaiaFixtureState,
  PendingCapabilityApprovalDto,
  SecurityProfile,
} from '@/api/types'
import { upsertExactAllowlistEntry } from '@/state/allowlistIdentity'

export type MaiaAction =
  | { type: 'complete_onboarding'; credential_backend: MaiaFixtureState['credential_backend']['active_backend'] }
  | { type: 'set_credential_backend'; backend: MaiaFixtureState['credential_backend']['active_backend'] }
  | { type: 'request_profile'; profile: SecurityProfile }
  | { type: 'confirm_unrestricted'; confirmed_at: string; desktop_client_id: string }
  | { type: 'return_to_protected'; at: string; by: string }
  | { type: 'set_allowlist_enabled'; id: string; enabled: boolean }
  | { type: 'revoke_allowlist_entry'; id: string }
  | { type: 'update_allowlist_entry'; id: string; label: string; matcher: ActionMatcher; enabled: boolean }
  | { type: 'set_client_class'; client_class: ClientClass }
  | { type: 'stop_all'; at: string }
  | { type: 'approval_allow_once'; approval_id: string; at: string }
  | { type: 'approval_always_allow_exact'; approval_id: string; at: string; created_by: string }
  | { type: 'approval_deny'; approval_id: string; at: string }

export function buildAllowlistEntryFromApproval(
  pending: PendingCapabilityApprovalDto,
  created_by: string,
  created_at: string,
): MaiaFixtureState['allowlist'][number] {
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

export function resolvePendingApproval(
  state: MaiaFixtureState,
  approval_id: string,
): PendingCapabilityApprovalDto | null {
  if (!state.pending_approval || state.pending_approval.approval_id !== approval_id) {
    return null
  }
  return state.pending_approval
}

export function canEnableUnrestricted(clientClass: ClientClass): boolean {
  return clientClass === 'local_desktop'
}

export function canSelectProfile(
  profile: SecurityProfile,
  clientClass: ClientClass,
  current: SecurityProfile,
): { allowed: boolean; reason: string | null } {
  if (profile === 'unrestricted' && !canEnableUnrestricted(clientClass)) {
    return {
      allowed: false,
      reason: 'Change this on the desktop.',
    }
  }
  if (profile === current) {
    return { allowed: true, reason: null }
  }
  return { allowed: true, reason: null }
}

export function isUnrestrictedProfile(profile: SecurityProfile): boolean {
  return profile === 'unrestricted'
}

export function reduceMaiaState(state: MaiaFixtureState, action: MaiaAction): MaiaFixtureState {
  switch (action.type) {
    case 'complete_onboarding':
      return {
        ...state,
        onboarding_complete: true,
        credential_backend: {
          ...state.credential_backend,
          active_backend: action.credential_backend,
        },
      }
    case 'set_credential_backend':
      if (state.client_class !== 'local_desktop') {
        return state
      }
      return {
        ...state,
        credential_backend: {
          ...state.credential_backend,
          active_backend: action.backend,
        },
      }
    case 'request_profile': {
      const gate = canSelectProfile(action.profile, state.client_class, state.security.profile)
      if (!gate.allowed) {
        return state
      }
      if (action.profile === 'unrestricted') {
        return state
      }
      return {
        ...state,
        security: {
          ...state.security,
          profile: action.profile,
          activated_at: state.security.activated_at,
          activated_by: state.security.activated_by,
          local_unrestricted_confirmation: null,
        },
      }
    }
    case 'confirm_unrestricted':
      if (!canEnableUnrestricted(state.client_class)) {
        return state
      }
      return {
        ...state,
        security: {
          profile: 'unrestricted',
          activated_at: action.confirmed_at,
          activated_by: action.desktop_client_id,
          local_unrestricted_confirmation: {
            confirmed_at: action.confirmed_at,
            desktop_client_id: action.desktop_client_id,
          },
        },
      }
    case 'return_to_protected':
      return {
        ...state,
        security: {
          profile: 'protected',
          activated_at: action.at,
          activated_by: action.by,
          local_unrestricted_confirmation: null,
        },
      }
    case 'set_allowlist_enabled':
      return {
        ...state,
        allowlist: state.allowlist.map((entry) =>
          entry.id === action.id ? { ...entry, enabled: action.enabled } : entry,
        ),
      }
    case 'revoke_allowlist_entry':
      return {
        ...state,
        allowlist: state.allowlist.filter((entry) => entry.id !== action.id),
      }
    case 'update_allowlist_entry':
      return {
        ...state,
        allowlist: state.allowlist.map((entry) =>
          entry.id === action.id
            ? {
                ...entry,
                label: action.label,
                matcher: action.matcher,
                enabled: action.enabled,
              }
            : entry,
        ),
      }
    case 'stop_all':
      return {
        ...state,
        activity: { running: 0, needs_human: 0 },
        pending_approval: null,
        panic_latch: { engaged: true, engaged_at: action.at },
      }
    case 'approval_allow_once': {
      const pending = resolvePendingApproval(state, action.approval_id)
      if (!pending) {
        return state
      }
      return {
        ...state,
        pending_approval: null,
        activity: { ...state.activity, needs_human: 0 },
      }
    }
    case 'approval_always_allow_exact': {
      const pending = resolvePendingApproval(state, action.approval_id)
      if (!pending) {
        return state
      }
      const entry = buildAllowlistEntryFromApproval(pending, action.created_by, action.at)
      return {
        ...state,
        pending_approval: null,
        activity: { ...state.activity, needs_human: 0 },
        allowlist: upsertExactAllowlistEntry(state.allowlist, entry),
      }
    }
    case 'approval_deny': {
      const pending = resolvePendingApproval(state, action.approval_id)
      if (!pending) {
        return state
      }
      return {
        ...state,
        pending_approval: null,
        activity: { ...state.activity, needs_human: 0 },
      }
    }
    case 'set_client_class':
      return { ...state, client_class: action.client_class }
    default:
      return state
  }
}

export function selectUnrestrictedBannerVisible(state: MaiaFixtureState): boolean {
  return state.security.profile === 'unrestricted'
}

export function selectNeedsHumanBannerVisible(state: MaiaFixtureState): boolean {
  return state.pending_approval !== null && state.activity.needs_human > 0
}

export function selectAllowlistEntries(
  state: MaiaFixtureState,
  query: string,
): MaiaFixtureState['allowlist'] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return state.allowlist
  }
  return state.allowlist.filter(
    (entry) =>
      entry.label.toLowerCase().includes(normalized) ||
      entry.capability.includes(normalized) ||
      entry.id.toLowerCase().includes(normalized),
  )
}

export function profileRank(profile: SecurityProfile): number {
  switch (profile) {
    case 'protected':
      return 0
    case 'allowlisted':
      return 1
    case 'unrestricted':
      return 2
  }
}

export function canTightenToProfile(
  from: SecurityProfile,
  to: SecurityProfile,
): boolean {
  return profileRank(to) <= profileRank(from)
}
