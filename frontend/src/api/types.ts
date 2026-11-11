/** DTO shapes aligned with accepted daemon routes (fixture-only in Slice F). */

export type SecurityProfile = 'protected' | 'allowlisted' | 'unrestricted'

export type ClientClass = 'local_desktop' | 'remote_owner'

export type OwnerClientId = string
export type GrantId = string
export type AgentId = string
export type Timestamp = string

export type CapabilityKind =
  | 'shell'
  | 'web'
  | 'file'
  | 'secret'
  | 'browser'
  | 'thread'

export type PlatformKind = 'windows' | 'linux' | 'macos'

export type GrantLifetime =
  | { kind: 'permanent' }
  | { kind: 'expires_at'; expires_at: Timestamp }
  | { kind: 'daemon_lifetime'; generation: number }

export interface CommandMatcher {
  kind: 'command'
  platform: PlatformKind
  executable: string
  args: string[]
}

export interface WebMatcher {
  kind: 'web'
  host: string
  path_prefix: string
}

export type ActionMatcher = CommandMatcher | WebMatcher

export interface AllowlistEntryDto {
  id: GrantId
  capability: CapabilityKind
  matcher: ActionMatcher
  agent: AgentId | null
  lifetime: GrantLifetime
  enabled: boolean
  created_at: Timestamp
  created_by: OwnerClientId
  label: string
}

export interface ConfirmationRecordDto {
  confirmed_at: Timestamp
  desktop_client_id: OwnerClientId
}

export interface SecurityProfileDto {
  profile: SecurityProfile
  activated_at: Timestamp
  activated_by: OwnerClientId
  local_unrestricted_confirmation: ConfirmationRecordDto | null
}

export type ContainmentVerdict = 'unattended_ready' | 'needs_human'

export interface CapabilityProbeResult {
  name: string
  passed: boolean
  safe_reason: string | null
}

export interface PlatformCapabilitySnapshotDto {
  platform: PlatformKind
  observed_at: Timestamp
  adapter_version: string
  overall_verdict: ContainmentVerdict
  probes: CapabilityProbeResult[]
  kernel_version: string | null
  landlock_abi: number | null
}

export type CredentialBackendKind = 'native' | 'encrypted_file' | 'vault_openbao'

export type EncryptedFileLockState = 'unlocked' | 'locked' | 'unavailable'

export interface CredentialBackendSettingsDto {
  active_backend: CredentialBackendKind
  encrypted_file_idle_timeout_minutes: number
  native_store_label: string
}

export interface AuditHealthDto {
  chain_status: 'verified' | 'degraded' | 'failed'
  last_verified_at: Timestamp
}

export interface ActivityCounts {
  running: number
  needs_human: number
}

export interface PanicLatchDto {
  engaged: boolean
  engaged_at: Timestamp | null
}

export interface PendingCapabilityApprovalDto {
  approval_id: string
  capability: CapabilityKind
  target_label: string
  digest: string
  matcher: ActionMatcher
}

export interface InspectorCacheSlotDto {
  id: string
  label: string
  section: 'fixed' | 'memory' | 'recall'
  taint?: 'trusted' | 'untrusted'
}

export interface InspectorFixtureDto {
  turn: number
  cached_percent: number
  cache_slots: InspectorCacheSlotDto[]
  brain_nodes: { id: string; label: string }[]
  trace_steps: { id: string; label: string; match_label: 'full' | 'half' | 'rejected' }[]
}

export interface MaiaFixtureState {
  onboarding_complete: boolean
  client_class: ClientClass
  security: SecurityProfileDto
  capabilities: PlatformCapabilitySnapshotDto
  allowlist: AllowlistEntryDto[]
  credential_backend: CredentialBackendSettingsDto
  encrypted_file_lock_state: EncryptedFileLockState
  activity: ActivityCounts
  audit: AuditHealthDto
  panic_latch: PanicLatchDto
  pending_approval: PendingCapabilityApprovalDto | null
  inspector: InspectorFixtureDto
}

export interface PutSecurityProfileBody {
  profile: SecurityProfile
  unrestricted_confirmation?: boolean
}
