use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use maia_store::McpAuditWrite;
use maia_store::McpConnectionRecord;
use maia_store::McpSecretSlot;
use maia_store::McpTransportRecord;
use maia_store::OwnerOpen;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::TaskWrite;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

fn open(name: &str) -> (PathBuf, SqliteOwner) {
    let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let directory = std::env::temp_dir().join(format!(
        "maia-mcp-{name}-{}-{sequence}",
        process::id()
    ));
    fs::create_dir_all(&directory).expect("temp dir");
    let file = directory.join("maia.sqlite");
    let owner = SqliteOwner::open(OwnerOpen {
        path: file.clone(),
        now: 1,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("open");
    (file, owner)
}

fn http_connection(hash: Option<String>) -> McpConnectionRecord {
    McpConnectionRecord {
        id: "web".into(),
        label: "Web".into(),
        transport: McpTransportRecord::Http {
            url: "https://mcp.example.com/mcp".into(),
            headers: vec![McpSecretSlot {
                name: "Authorization".into(),
                secret_ref: "slot-1".into(),
            }],
        },
        admitted_hash: hash,
        listed_canonical: None,
        listed_hash: None,
        refresh_error: None,
    }
}

#[test]
fn transport_edit_clears_the_admitted_hash_and_rows_omit_secret_values() {
    let (file, owner) = open("hash");
    owner.create_mcp(http_connection(None)).expect("create");
    owner
        .store_mcp_list("web", "{\"name\":\"scrape\"}", "hash-a")
        .expect("list");
    owner.admit_mcp("web", "hash-a").expect("admit");
    owner
        .replace_mcp_transport(
            "web",
            McpTransportRecord::Http {
                url: "https://mcp.example.com/other".into(),
                headers: vec![McpSecretSlot {
                    name: "Authorization".into(),
                    secret_ref: "slot-2".into(),
                }],
            },
        )
        .expect("replace");
    let rows = owner.list_mcp().expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].admitted_hash, None);
    assert_eq!(rows[0].listed_hash, None);
    let bytes = fs::read(&file).expect("database");
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("super-secret-value"));
    assert!(matches!(
        owner.admit_mcp("web", "hash-a"),
        Err(StoreError::InvalidRequest { .. })
    ));
}

#[test]
fn label_edit_keeps_the_admitted_hash() {
    let (_file, owner) = open("label");
    owner.create_mcp(http_connection(None)).expect("create");
    owner
        .store_mcp_list("web", "[]", "hash-b")
        .expect("list");
    owner.admit_mcp("web", "hash-b").expect("admit");
    owner.update_mcp_label("web", "Pages").expect("label");
    let rows = owner.list_mcp().expect("rows");
    assert_eq!(rows[0].label, "Pages");
    assert_eq!(rows[0].admitted_hash.as_deref(), Some("hash-b"));
}

#[test]
fn guidance_and_audit_store_no_call_arguments() {
    let (file, owner) = open("audit");
    owner
        .insert_task(TaskWrite {
            task_id: "task-1".into(),
            phase: "queued".into(),
            title: "Look".into(),
            pin: "unpinned".into(),
            completion_view: "unopened".into(),
            prior_task_id: None,
            created_at: 1,
            attempt_id: "attempt-1".into(),
            attempt_state: "active".into(),
        })
        .expect("task");
    owner
        .put_task_guidance("task-1", "call web__scrape")
        .expect("guidance");
    assert_eq!(
        owner.task_guidance("task-1").expect("read"),
        Some("call web__scrape".into())
    );
    owner
        .insert_mcp_audit(McpAuditWrite {
            connection_id: "web".into(),
            wire_name: "web__scrape".into(),
            manifest_hash: "hash-b".into(),
            exchange_class: "known_result".into(),
            result_sha256: "abc".into(),
        })
        .expect("audit");
    let bytes = fs::read(file).expect("database");
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("super-secret-value"));
    assert!(!text.contains("arguments"));
}
