//! Co-use reversal, promotion links, approvals, and attachment rows.

use std::fs;
use std::path::PathBuf;
use std::process;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use maia_store::AppendEvents;
use maia_store::ApprovalDecision;
use maia_store::ApprovalSettlement;
use maia_store::ApprovalWrite;
use maia_store::AttachmentWrite;
use maia_store::CoUseWrite;
use maia_store::EpisodeWrite;
use maia_store::EvidenceSource;
use maia_store::LedgerWrite;
use maia_store::MemoryKind;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PresentationWrite;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionLinkWrite;
use maia_store::PromotionWrite;
use maia_store::SegmentWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::ThreadEventWrite;
use maia_store::MAX_ATTACHMENT_BYTES;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

struct TempOwner {
    directory: PathBuf,
    owner: Option<SqliteOwner>,
}

impl TempOwner {
    fn open(name: &str) -> Self {
        let sequence = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "maia-attention-{name}-{}-{sequence}",
            process::id()
        ));
        fs::create_dir_all(&directory).expect("temp dir");
        let owner = SqliteOwner::open(OwnerOpen {
            path: directory.join("maia.sqlite"),
            now: 10,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .expect("owner");
        Self {
            directory,
            owner: Some(owner),
        }
    }

    fn owner(&self) -> &SqliteOwner {
        self.owner.as_ref().expect("owner")
    }

    fn reopen(&mut self, now: i64) {
        if let Some(owner) = self.owner.take() {
            owner.shutdown().expect("shutdown");
        }
        self.owner = Some(
            SqliteOwner::open(OwnerOpen {
                path: self.directory.join("maia.sqlite"),
                now,
                normal_capacity: 8,
                panic_capacity: 2,
            })
            .expect("reopen"),
        );
    }
}

impl Drop for TempOwner {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn seed(owner: &SqliteOwner) {
    owner
        .append(AppendEvents {
            thread_id: "thread-1".to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: 10,
            events: vec![ThreadEventWrite {
                event_id: "open".to_owned(),
                kind: "system".to_owned(),
                body: "open".to_owned(),
            }],
        })
        .expect("thread");
}

fn episode(owner: &SqliteOwner, episode_id: &str) {
    owner
        .insert_episode(EpisodeWrite {
            episode_id: episode_id.to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: format!("turn-{episode_id}"),
            body: "Northwind pantry stores flour.".to_owned(),
            taint: MemoryTaint::Untrusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: 20,
            segments: vec![SegmentWrite {
                text: "Northwind pantry stores flour.".to_owned(),
                taint: MemoryTaint::Untrusted,
                sources: "owner".to_owned(),
            }],
        })
        .expect("episode");
}

fn presentation(id: &str, claim_id: &str) -> PresentationWrite {
    PresentationWrite {
        presentation_id: id.to_owned(),
        candidate_kind: MemoryKind::Claim,
        candidate_id: claim_id.to_owned(),
        source: EvidenceSource::Reply,
        weight: 0.5,
        source_span_start: 0,
        source_span_end: 4,
        evidence_span_start: 0,
        evidence_span_end: 4,
        thread_id: "thread-1".to_owned(),
    }
}

#[test]
fn co_use_thickens_once_and_reversal_removes_the_edge() {
    let db = TempOwner::open("co-use");
    seed(db.owner());
    let ledger = LedgerWrite {
        ledger_id: "ledger-1".to_owned(),
        thread_id: "thread-1".to_owned(),
        request_id: "message-1".to_owned(),
        compiled_prefix_hash: "prefix".to_owned(),
        applied_at: 30,
        presentations: vec![
            presentation("pres-a", "claim-a"),
            presentation("pres-b", "claim-b"),
        ],
        heat: Vec::new(),
        co_use: vec![CoUseWrite {
            left_kind: MemoryKind::Claim,
            left_id: "claim-a".to_owned(),
            right_kind: MemoryKind::Claim,
            right_id: "claim-b".to_owned(),
            weight: 0.5,
        }],
        negative_marks: Vec::new(),
    };
    db.owner().apply_ledger(ledger.clone()).expect("ledger");
    db.owner().apply_ledger(ledger).expect("replay");
    let edge = db
        .owner()
        .brain_map()
        .expect("map")
        .edges
        .into_iter()
        .find(|edge| edge.kind == "co_use")
        .expect("co-use");
    assert_eq!(edge.weight_millis, 500);
    assert_eq!(
        db.owner().presented_ids("message-1".to_owned()).expect("used"),
        vec!["claim-a".to_owned(), "claim-b".to_owned()]
    );
    db.owner().reverse_ledger("ledger-1".to_owned(), 40).expect("reverse");
    assert!(
        db.owner()
            .brain_map()
            .expect("map")
            .edges
            .iter()
            .all(|edge| edge.kind != "co_use")
    );
    assert_eq!(
        db.owner().presented_ids("message-1".to_owned()).expect("kept"),
        vec!["claim-a".to_owned(), "claim-b".to_owned()]
    );
    db.owner()
        .reverse_ledger("ledger-1".to_owned(), 41)
        .expect("second reverse");
    assert!(
        db.owner()
            .brain_map()
            .expect("map")
            .edges
            .iter()
            .all(|edge| edge.kind != "co_use")
    );
}

#[test]
fn promotion_link_is_committed_with_the_claim_and_a_missing_target_rolls_back() {
    let db = TempOwner::open("link");
    seed(db.owner());
    episode(db.owner(), "episode-1");
    db.owner()
        .apply_promotion(PromotionWrite {
            episode_id: "episode-1".to_owned(),
            model: "model-a".to_owned(),
            now: 30,
            claims: vec![PromotionClaimWrite {
                claim_id: "claim-old".to_owned(),
                sentence: "Northwind pantry stores flour.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 20,
                lexemes: vec!["northwind".to_owned(), "pantry".to_owned()],
            ..Default::default()
        }],
            same_claim_ids: Vec::new(),
            replacements: Vec::new(),
            links: Vec::new(),
            session_bot_id: String::new(),
            session_summary: String::new(),
        })
        .expect("first");
    episode(db.owner(), "episode-2");
    let failed = db.owner().apply_promotion(PromotionWrite {
        episode_id: "episode-2".to_owned(),
        model: "model-a".to_owned(),
        now: 40,
        claims: vec![PromotionClaimWrite {
            claim_id: "claim-new".to_owned(),
            sentence: "Northwind pantry ships oats.".to_owned(),
            taint: MemoryTaint::Untrusted,
            valid_from: 20,
            lexemes: vec!["northwind".to_owned(), "pantry".to_owned()],
            ..Default::default()
        }],
        same_claim_ids: Vec::new(),
        replacements: Vec::new(),
        links: vec![PromotionLinkWrite {
            edge_kind: "relatedness".to_owned(),
            from_claim_id: "claim-new".to_owned(),
            to_kind: "claim".to_owned(),
            to_id: "missing-claim".to_owned(),
            weight_millis: 250,
        }],
        session_bot_id: String::new(),
        session_summary: String::new(),
    });
    assert!(matches!(failed, Err(StoreError::NotFound { .. })));
    assert!(
        db.owner()
            .brain_map()
            .expect("map")
            .nodes
            .iter()
            .all(|node| node.id != "claim-new")
    );
    db.owner()
        .apply_promotion(PromotionWrite {
            episode_id: "episode-2".to_owned(),
            model: "model-a".to_owned(),
            now: 40,
            claims: vec![PromotionClaimWrite {
                claim_id: "claim-new".to_owned(),
                sentence: "Northwind pantry ships oats.".to_owned(),
                taint: MemoryTaint::Untrusted,
                valid_from: 20,
                lexemes: vec!["northwind".to_owned(), "pantry".to_owned()],
            ..Default::default()
        }],
            same_claim_ids: Vec::new(),
            replacements: Vec::new(),
            links: vec![PromotionLinkWrite {
                edge_kind: "relatedness".to_owned(),
                from_claim_id: "claim-new".to_owned(),
                to_kind: "claim".to_owned(),
                to_id: "claim-old".to_owned(),
                weight_millis: 250,
            }],
            session_bot_id: String::new(),
            session_summary: String::new(),
        })
        .expect("linked");
    let edge = db
        .owner()
        .brain_map()
        .expect("map")
        .edges
        .into_iter()
        .find(|edge| edge.kind == "relatedness")
        .expect("relatedness");
    assert_eq!(edge.from_id, "claim-new");
    assert_eq!(edge.to_id, "claim-old");
    assert_eq!(edge.weight_millis, 250);
}

#[test]
fn approval_survives_restart_and_expiry_closes_it() {
    let mut db = TempOwner::open("approval");
    db.owner()
        .insert_approval(ApprovalWrite {
            approval_id: "7".to_owned(),
            task_id: "task-7".to_owned(),
            kind: "capability".to_owned(),
            taint: MemoryTaint::Untrusted,
            created_at: 10,
            expires_at: 1_000,
        })
        .expect("insert");
    db.reopen(11);
    let pending = db.owner().pending_approvals(20).expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].grant_text,
        "Grant the capability this task requested"
    );
    assert_eq!(pending[0].taint, MemoryTaint::Untrusted);
    let settled = db
        .owner()
        .decide_approval("7".to_owned(), ApprovalDecision::Approve, 30)
        .expect("decide");
    assert_eq!(
        settled.value,
        ApprovalSettlement::Approved {
            task_id: "task-7".to_owned()
        }
    );
    assert!(db.owner().pending_approvals(30).expect("empty").is_empty());
    db.owner()
        .insert_approval(ApprovalWrite {
            approval_id: "8".to_owned(),
            task_id: "task-8".to_owned(),
            kind: "login".to_owned(),
            taint: MemoryTaint::Trusted,
            created_at: 40,
            expires_at: 50,
        })
        .expect("second");
    let expired = db.owner().expire_approvals(50).expect("expire");
    assert_eq!(expired.value, vec!["task-8".to_owned()]);
    assert!(db.owner().pending_approvals(50).expect("closed").is_empty());
}

#[test]
fn attachment_rows_reject_active_types_and_keep_sent_files() {
    let db = TempOwner::open("attachment");
    let hash = "ab".repeat(32);
    let rejected = db.owner().insert_attachment(AttachmentWrite {
        attachment_id: "att-html".to_owned(),
        content_sha256: hash.clone(),
        byte_size: 12,
        media_type: "text/html".to_owned(),
        safe_name: "page.html".to_owned(),
        relative_path: format!("attachments/{hash}"),
        created_at: 10,
    });
    assert!(matches!(rejected, Err(StoreError::InvalidRequest { .. })));
    db.owner()
        .insert_attachment(AttachmentWrite {
            attachment_id: "att-1".to_owned(),
            content_sha256: hash.clone(),
            byte_size: 12,
            media_type: "text/plain".to_owned(),
            safe_name: "note.txt".to_owned(),
            relative_path: format!("attachments/{hash}"),
            created_at: 10,
        })
        .expect("insert");
    let too_big = db.owner().insert_attachment(AttachmentWrite {
        attachment_id: "att-big".to_owned(),
        content_sha256: hash.clone(),
        byte_size: MAX_ATTACHMENT_BYTES + 1,
        media_type: "text/plain".to_owned(),
        safe_name: "big.txt".to_owned(),
        relative_path: format!("attachments/{hash}"),
        created_at: 10,
    });
    assert!(matches!(too_big, Err(StoreError::InvalidRequest { .. })));
    db.owner()
        .bind_attachments(vec!["att-1".to_owned()], "message-1".to_owned())
        .expect("bind");
    assert!(matches!(
        db.owner().delete_attachment("att-1".to_owned()),
        Err(StoreError::InvalidRequest { .. })
    ));
    let rows = db
        .owner()
        .attachments_for_message("message-1".to_owned())
        .expect("rows");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].media_type, "text/plain");
    assert!(rows[0].relative_path.starts_with("attachments/"));
}
