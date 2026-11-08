//! Security profile, allowlist, credential backend, and capability snapshots.

use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;

use crate::canonical::require_text;
use crate::error::StoreError;
use crate::types::AllowlistEntryWrite;
use crate::types::CapabilitySnapshotWrite;
use crate::types::CredentialBackend;
use crate::types::CredentialBackendWrite;
use crate::types::GrantLifetime;
use crate::types::MatcherKind;
use crate::types::PlatformKind;
use crate::types::PresenceProof;
use crate::types::SecurityProfile;
use crate::types::SecuritySettingsWrite;
use crate::types::UnrestrictedConfirmation;

fn validate_settings(request: &SecuritySettingsWrite) -> Result<(), StoreError> {
    require_text("activated_by", &request.activated_by)?;
    match (&request.profile, &request.confirmation) {
        (SecurityProfile::Unrestricted, None) => Err(StoreError::InvalidRequest {
            message: "unrestricted requires a local confirmation".to_owned(),
        }),
        (SecurityProfile::Unrestricted, Some(confirmation)) => {
            require_text("desktop_client_id", &confirmation.desktop_client_id)
        }
        (_, Some(_)) => Err(StoreError::InvalidRequest {
            message: "confirmation is stored only for unrestricted".to_owned(),
        }),
        (_, None) => Ok(()),
    }
}

pub(crate) fn put_settings(
    connection: &mut Connection,
    request: &SecuritySettingsWrite,
) -> Result<(), StoreError> {
    validate_settings(request)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let (confirmed_at, client, proof) = match &request.confirmation {
        None => (None, None, None),
        Some(UnrestrictedConfirmation {
            confirmed_at,
            desktop_client_id,
            presence_proof,
        }) => (
            Some(*confirmed_at),
            Some(desktop_client_id.as_str()),
            Some(presence_proof.as_str()),
        ),
    };
    transaction.execute(
        "INSERT INTO security_settings (singleton, profile, activated_at, activated_by, confirmation_at, \
         confirmation_desktop_client, confirmation_presence_proof) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT (singleton) DO UPDATE SET profile = excluded.profile, activated_at = excluded.activated_at, \
         activated_by = excluded.activated_by, confirmation_at = excluded.confirmation_at, \
         confirmation_desktop_client = excluded.confirmation_desktop_client, \
         confirmation_presence_proof = excluded.confirmation_presence_proof",
        params![
            request.profile.as_str(),
            request.activated_at,
            request.activated_by,
            confirmed_at,
            client,
            proof
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn settings(
    connection: &Connection,
) -> Result<Option<SecuritySettingsWrite>, StoreError> {
    let row = connection
        .query_row(
            "SELECT profile, activated_at, activated_by, confirmation_at, confirmation_desktop_client, \
             confirmation_presence_proof FROM security_settings WHERE singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()?;
    let Some((profile, activated_at, activated_by, confirmed_at, client, proof)) = row else {
        return Ok(None);
    };
    let confirmation = match (confirmed_at, client, proof) {
        (None, None, None) => None,
        (Some(confirmed_at), Some(desktop_client_id), Some(proof)) => {
            Some(UnrestrictedConfirmation {
                confirmed_at,
                desktop_client_id,
                presence_proof: PresenceProof::parse(&proof)?,
            })
        }
        _ => {
            return Err(StoreError::InvalidRequest {
                message: "security confirmation row is incomplete".to_owned(),
            });
        }
    };
    Ok(Some(SecuritySettingsWrite {
        profile: SecurityProfile::parse(&profile)?,
        activated_at,
        activated_by,
        confirmation,
    }))
}

fn lifetime_columns(
    lifetime: &GrantLifetime,
) -> Result<(&'static str, Option<i64>, Option<i64>), StoreError> {
    match lifetime {
        GrantLifetime::Permanent => Ok(("permanent", None, None)),
        GrantLifetime::ExpiresAt { at } => Ok(("expires_at", Some(*at), None)),
        GrantLifetime::DaemonLifetime { generation } => {
            let generation =
                i64::try_from(*generation).map_err(|_| StoreError::InvalidRequest {
                    message: "daemon generation does not fit".to_owned(),
                })?;
            Ok(("daemon_lifetime", None, Some(generation)))
        }
    }
}

fn lifetime_from_columns(
    kind: &str,
    at: Option<i64>,
    generation: Option<i64>,
) -> Result<GrantLifetime, StoreError> {
    match (kind, at, generation) {
        ("permanent", None, None) => Ok(GrantLifetime::Permanent),
        ("expires_at", Some(at), None) => Ok(GrantLifetime::ExpiresAt { at }),
        ("daemon_lifetime", None, Some(generation)) => {
            let generation = u64::try_from(generation).map_err(|_| StoreError::InvalidRequest {
                message: "stored daemon generation is negative".to_owned(),
            })?;
            Ok(GrantLifetime::DaemonLifetime { generation })
        }
        _ => Err(StoreError::InvalidRequest {
            message: "allowlist lifetime row is incomplete".to_owned(),
        }),
    }
}

fn allowlist_same(stored: &AllowlistEntryWrite, request: &AllowlistEntryWrite) -> bool {
    stored.capability == request.capability
        && stored.matcher_kind == request.matcher_kind
        && stored.matcher_canonical == request.matcher_canonical
        && stored.agent_id == request.agent_id
        && stored.lifetime == request.lifetime
        && stored.enabled == request.enabled
        && stored.created_at == request.created_at
        && stored.created_by == request.created_by
}

pub(crate) fn put_allowlist(
    connection: &mut Connection,
    request: &AllowlistEntryWrite,
) -> Result<(), StoreError> {
    require_text("grant_id", &request.grant_id)?;
    require_text("capability", &request.capability)?;
    require_text("matcher_canonical", &request.matcher_canonical)?;
    require_text("created_by", &request.created_by)?;
    if let Some(agent_id) = &request.agent_id {
        require_text("agent_id", agent_id)?;
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = load_allowlist(&transaction)?;
    if let Some(stored) = existing
        .iter()
        .find(|entry| entry.grant_id == request.grant_id)
    {
        if allowlist_same(stored, request) {
            transaction.commit()?;
            return Ok(());
        }
        return Err(StoreError::IdempotencyConflict {
            key: request.grant_id.clone(),
        });
    }
    let (lifetime_kind, lifetime_at, lifetime_generation) = lifetime_columns(&request.lifetime)?;
    transaction.execute(
        "INSERT INTO allowlist_entries (grant_id, capability, matcher_kind, matcher_canonical, agent_id, \
         lifetime_kind, lifetime_at, lifetime_generation, enabled, created_at, created_by) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            request.grant_id,
            request.capability,
            request.matcher_kind.as_str(),
            request.matcher_canonical,
            request.agent_id,
            lifetime_kind,
            lifetime_at,
            lifetime_generation,
            i64::from(request.enabled),
            request.created_at,
            request.created_by
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn set_enabled(
    connection: &mut Connection,
    grant_id: &str,
    enabled: bool,
) -> Result<(), StoreError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let updated = transaction.execute(
        "UPDATE allowlist_entries SET enabled = ?1 WHERE grant_id = ?2",
        params![i64::from(enabled), grant_id],
    )?;
    if updated != 1 {
        return Err(StoreError::NotFound {
            entity: "allowlist",
            id: grant_id.to_owned(),
        });
    }
    transaction.commit()?;
    Ok(())
}

pub(crate) fn allowlist(connection: &Connection) -> Result<Vec<AllowlistEntryWrite>, StoreError> {
    load_allowlist(connection)
}

fn load_allowlist(connection: &Connection) -> Result<Vec<AllowlistEntryWrite>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT grant_id, capability, matcher_kind, matcher_canonical, agent_id, lifetime_kind, lifetime_at, \
         lifetime_generation, enabled, created_at, created_by FROM allowlist_entries ORDER BY grant_id",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, i64>(9)?,
            row.get::<_, String>(10)?,
        ))
    })?;
    let mut entries = Vec::new();
    for row in mapped {
        let (
            grant_id,
            capability,
            matcher_kind,
            matcher_canonical,
            agent_id,
            lifetime_kind,
            lifetime_at,
            lifetime_generation,
            enabled,
            created_at,
            created_by,
        ) = row?;
        entries.push(AllowlistEntryWrite {
            grant_id,
            capability,
            matcher_kind: MatcherKind::parse(&matcher_kind)?,
            matcher_canonical,
            agent_id,
            lifetime: lifetime_from_columns(&lifetime_kind, lifetime_at, lifetime_generation)?,
            enabled: enabled == 1,
            created_at,
            created_by,
        });
    }
    Ok(entries)
}

pub(crate) fn put_backend(
    connection: &mut Connection,
    request: &CredentialBackendWrite,
) -> Result<(), StoreError> {
    let timeout = i64::try_from(request.encrypted_file_idle_timeout_ms).map_err(|_| {
        StoreError::InvalidRequest {
            message: "idle timeout does not fit".to_owned(),
        }
    })?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "INSERT INTO credential_backend_settings (singleton, active_backend, encrypted_file_idle_timeout_ms) \
         VALUES (1, ?1, ?2) ON CONFLICT (singleton) DO UPDATE SET active_backend = excluded.active_backend, \
         encrypted_file_idle_timeout_ms = excluded.encrypted_file_idle_timeout_ms",
        params![request.backend.as_str(), timeout],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn backend(
    connection: &Connection,
) -> Result<Option<CredentialBackendWrite>, StoreError> {
    connection
        .query_row(
            "SELECT active_backend, encrypted_file_idle_timeout_ms FROM credential_backend_settings \
             WHERE singleton = 1",
            [],
            |row| {
                let backend: String = row.get(0)?;
                let timeout: i64 = row.get(1)?;
                Ok((backend, timeout))
            },
        )
        .optional()?
        .map(|(backend, timeout)| {
            let timeout = u64::try_from(timeout).map_err(|_| StoreError::InvalidRequest {
                message: "stored idle timeout is negative".to_owned(),
            })?;
            Ok(CredentialBackendWrite {
                backend: CredentialBackend::parse(&backend)?,
                encrypted_file_idle_timeout_ms: timeout,
            })
        })
        .transpose()
}

fn snapshot_same(stored: &CapabilitySnapshotWrite, request: &CapabilitySnapshotWrite) -> bool {
    stored.observed_at == request.observed_at
        && stored.platform == request.platform
        && stored.adapter_version == request.adapter_version
        && stored.verdict == request.verdict
        && stored.kernel == request.kernel
        && stored.landlock_abi == request.landlock_abi
        && stored.probe_canonical == request.probe_canonical
}

pub(crate) fn put_snapshot(
    connection: &mut Connection,
    request: &CapabilitySnapshotWrite,
) -> Result<(), StoreError> {
    require_text("snapshot_id", &request.snapshot_id)?;
    require_text("adapter_version", &request.adapter_version)?;
    require_text("verdict", &request.verdict)?;
    require_text("probe_canonical", &request.probe_canonical)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let existing = load_snapshots(&transaction)?;
    if let Some(stored) = existing
        .iter()
        .find(|row| row.snapshot_id == request.snapshot_id)
    {
        if !snapshot_same(stored, request) {
            return Err(StoreError::IdempotencyConflict {
                key: request.snapshot_id.clone(),
            });
        }
    } else {
        transaction.execute(
            "INSERT INTO platform_capability_snapshots (snapshot_id, observed_at, platform, adapter_version, \
             verdict, kernel, landlock_abi, probe_canonical) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                request.snapshot_id,
                request.observed_at,
                request.platform.as_str(),
                request.adapter_version,
                request.verdict,
                request.kernel,
                request.landlock_abi,
                request.probe_canonical
            ],
        )?;
    }
    transaction.execute(
        "DELETE FROM platform_capability_snapshots WHERE snapshot_id NOT IN ( \
         SELECT snapshot_id FROM platform_capability_snapshots ORDER BY observed_at DESC, snapshot_id DESC LIMIT 32)",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn snapshots(
    connection: &Connection,
) -> Result<Vec<CapabilitySnapshotWrite>, StoreError> {
    load_snapshots(connection)
}

fn load_snapshots(connection: &Connection) -> Result<Vec<CapabilitySnapshotWrite>, StoreError> {
    let mut statement = connection.prepare(
        "SELECT snapshot_id, observed_at, platform, adapter_version, verdict, kernel, landlock_abi, probe_canonical \
         FROM platform_capability_snapshots ORDER BY observed_at ASC, snapshot_id ASC",
    )?;
    let mapped = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut rows = Vec::new();
    for row in mapped {
        let (
            snapshot_id,
            observed_at,
            platform,
            adapter_version,
            verdict,
            kernel,
            landlock_abi,
            probe_canonical,
        ) = row?;
        rows.push(CapabilitySnapshotWrite {
            snapshot_id,
            observed_at,
            platform: PlatformKind::parse(&platform)?,
            adapter_version,
            verdict,
            kernel,
            landlock_abi,
            probe_canonical,
        });
    }
    Ok(rows)
}
