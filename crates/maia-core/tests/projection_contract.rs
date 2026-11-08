//! Vault projection is a retryable description of committed rows.

use std::collections::BTreeMap;

use maia_core::audit::Timestamp;
use maia_core::brain::{FactId, LexemeId};
use maia_core::dream::PageSource;
use maia_core::dream::{
    DreamBatchId, DreamFact, EntityId, EntityRow, EntityScope, FactCurrency, PageOutcome,
    ProjectionProgress, ProjectionRecord, render_projection, screen_projection_path,
};
use maia_core::security::Taint;
use maia_core::vault::{NoteHeader, VaultPath};

fn entity() -> EntityRow {
    EntityRow {
        id: EntityId::new("entity_obsidian"),
        slug: "obsidian".to_owned(),
        description: "A local knowledge base.".to_owned(),
        scope: EntityScope::World,
        see: Vec::new(),
        taint: Taint::Trusted,
    }
}

fn fact(id: &str, sentence: &str, currency: FactCurrency) -> DreamFact {
    DreamFact {
        id: FactId::new(id),
        sentence: sentence.to_owned(),
        taint: Taint::Trusted,
        lexemes: vec![LexemeId::new("vault")],
        episode_ids: Vec::new(),
        entity_id: Some(EntityId::new("entity_obsidian")),
        claim_ids: Vec::new(),
        valid_from: Timestamp(1),
        hold: None,
        currency,
    }
}

fn record() -> ProjectionRecord {
    ProjectionRecord {
        batch_id: DreamBatchId::new("batch_01"),
        entities: vec![EntityId::new("entity_obsidian")],
        folders: vec![VaultPath::parse("world/entities/index").expect("folder")],
        progress: ProjectionProgress::Pending,
    }
}

#[test]
fn projection_renders_only_current_facts_and_is_idempotent() {
    let facts = vec![
        fact(
            "fact_closed",
            "Closed history stays out.",
            FactCurrency::Closed {
                valid_end: Timestamp(2),
            },
        ),
        fact(
            "fact_b",
            "Beta stays.",
            FactCurrency::Merged {
                into: FactId::new("fact_a"),
            },
        ),
        fact("fact_a", "Alpha stays.", FactCurrency::Current),
    ];
    let indexes = BTreeMap::from([(
        VaultPath::parse("world/entities/index").expect("folder"),
        vec![NoteHeader {
            link: "world/entities/obsidian".to_owned(),
            description: "A local knowledge base.".to_owned(),
        }],
    )]);
    let first = render_projection(&record(), &[entity()], &facts, &[], &indexes).expect("render");
    let second = render_projection(&record(), &[entity()], &facts, &[], &indexes).expect("retry");
    assert_eq!(first, second);
    let PageOutcome::Replace { bytes, .. } = &first.pages[0] else {
        panic!("expected replacement bytes");
    };
    let text = String::from_utf8(bytes.clone()).expect("utf8");
    assert_eq!(
        text,
        "---\nid: entity_obsidian\ndescription: A local knowledge base.\nsee: []\nkind: entity\n---\n<!-- maia:generated:start -->\n- `fact_a`: Alpha stays.\n<!-- maia:generated:end -->\n<!-- maia:human:start -->\n<!-- maia:human:end -->\n"
    );
    assert!(!text.contains("Closed history"));
    assert!(!text.contains("Beta stays"));
    assert_eq!(
        first.indexes,
        vec![(
            VaultPath::parse("world/entities/index").expect("folder"),
            "- [[world/entities/obsidian]] — A local knowledge base.\n".to_owned(),
        )]
    );
    assert_eq!(first.progress, ProjectionProgress::Complete);
}

#[test]
fn existing_human_bytes_survive_and_concurrent_edits_restage() {
    let human =
        "<!-- maia:human:start -->\r\n## Notes\r\n\r\n  café  \r\n<!-- maia:human:end -->\r\n";
    let existing = format!(
        "---\nid: entity_obsidian\ndescription: A local knowledge base.\nsee: []\nkind: entity\n---\n<!-- maia:generated:start -->\n- `fact_old`: Old line.\n<!-- maia:generated:end -->\n{human}"
    );
    let bytes = existing.into_bytes();
    let page = PageSource {
        path: VaultPath::parse("world/entities/obsidian").expect("path"),
        current_bytes: bytes.clone(),
        bytes_read_for_rendering: bytes.clone(),
    };
    let rendered = render_projection(
        &record(),
        &[entity()],
        &[fact("fact_a", "Alpha stays.", FactCurrency::Current)],
        &[page],
        &BTreeMap::new(),
    )
    .expect("render");
    let PageOutcome::Replace { bytes: next, .. } = &rendered.pages[0] else {
        panic!("expected replacement");
    };
    let text = String::from_utf8(next.clone()).expect("utf8");
    assert!(text.contains(human.trim_end_matches('\n')) || text.contains(human));
    let start = text.find("<!-- maia:human:start -->").expect("human start");
    let original_start = String::from_utf8(bytes.clone()).expect("utf8");
    let original_start = original_start
        .find("<!-- maia:human:start -->")
        .expect("human start");
    let original = String::from_utf8(bytes).expect("utf8");
    assert_eq!(&text[start..], &original[original_start..]);

    let edited = original.replace("café", "café edited");
    let restaged = render_projection(
        &record(),
        &[entity()],
        &[fact("fact_a", "Alpha stays.", FactCurrency::Current)],
        &[PageSource {
            path: VaultPath::parse("world/entities/obsidian").expect("path"),
            current_bytes: edited.into_bytes(),
            bytes_read_for_rendering: original.into_bytes(),
        }],
        &BTreeMap::new(),
    )
    .expect("restage");
    assert_eq!(
        restaged.pages,
        vec![PageOutcome::Restage {
            path: VaultPath::parse("world/entities/obsidian").expect("path"),
        }]
    );
    assert_eq!(restaged.progress, ProjectionProgress::Pending);
}

#[test]
fn personality_targets_are_rejected_before_any_page_bytes() {
    let path = VaultPath::parse("agents/scout/personality").expect("path");
    assert_eq!(
        screen_projection_path(&path),
        Err(maia_core::dream::DreamError::PersonalityTarget)
    );
    let mut personality = entity();
    personality.slug = "personality".to_owned();
    personality.id = EntityId::new("entity_personality");
    let mut listed = record();
    listed.entities = vec![EntityId::new("entity_personality")];
    let rendered = render_projection(&listed, &[personality], &[], &[], &BTreeMap::new());
    assert_eq!(
        rendered,
        Err(maia_core::dream::DreamError::PersonalityTarget)
    );
}

#[test]
fn broken_markers_block_one_page_and_leave_projection_pending() {
    let broken = b"---\nid: entity_obsidian\ndescription: A local knowledge base.\nsee: []\nkind: entity\n---\nno markers\n".to_vec();
    let rendered = render_projection(
        &record(),
        &[entity()],
        &[],
        &[PageSource {
            path: VaultPath::parse("world/entities/obsidian").expect("path"),
            current_bytes: broken.clone(),
            bytes_read_for_rendering: broken,
        }],
        &BTreeMap::new(),
    )
    .expect("blocked page");
    assert_eq!(
        rendered.pages,
        vec![PageOutcome::Blocked {
            path: VaultPath::parse("world/entities/obsidian").expect("path"),
            error: maia_core::dream::DreamError::InvalidRegionMarkers,
        }]
    );
    assert_eq!(rendered.progress, ProjectionProgress::Pending);
}
