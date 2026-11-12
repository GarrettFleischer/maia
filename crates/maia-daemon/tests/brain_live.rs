//! In-process recall, export, and auto-link check on a temporary database.
//!
//! Does not open `data/maia.sqlite` and does not bind a port. The owner's daemon
//! stays on 4178.

use std::fs;
use std::path::PathBuf;

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use maia_core::audit::Timestamp;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::lexemes_for_sentence;
use maia_daemon::recall_run;
use maia_store::AppendEvents;
use maia_store::ConsolidationWrite;
use maia_store::EpisodeWrite;
use maia_store::FactWrite;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::SqliteOwner;
use maia_store::SupersedeWrite;
use maia_store::ThreadEventWrite;

const NOW: i64 = 1_763_000_000;

fn open_temp(label: &str) -> (PathBuf, SqliteOwner) {
    let directory =
        std::env::temp_dir().join(format!("maia-brain-live-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("brain.sqlite");
    let owner = SqliteOwner::open(OwnerOpen {
        path,
        now: NOW,
        normal_capacity: 8,
        panic_capacity: 2,
    })
    .expect("open");
    (directory, owner)
}

fn note_lexemes(sentence: &str) -> Vec<String> {
    let policy = LexicalPolicy {
        stopwords: BTreeSet::from([
            "a".to_owned(),
            "the".to_owned(),
            "at".to_owned(),
            "in".to_owned(),
            "of".to_owned(),
            "and".to_owned(),
            "for".to_owned(),
            "on".to_owned(),
            "to".to_owned(),
        ]),
        fan_out: BTreeMap::new(),
        high_fan_cutoff: 100,
    };
    lexemes_for_sentence(sentence, &policy)
        .into_iter()
        .map(|lexeme| lexeme.as_str().to_owned())
        .collect()
}

fn sentences() -> Vec<(&'static str, &'static str)> {
    vec![
        ("alice", "Alice Chen keeps the Quartz vault."),
        ("path", "Notes live at F:\\Development\\Ideas."),
        ("bob", "Bob Nguyen lives in Portland."),
        ("zephyr", "Zephyr holds the indigo token."),
        ("carol", "Carol Diaz reviews morning pages."),
        ("obsidian", "Obsidian opens the local vault."),
        ("maia", "Maia stores episodes claims and facts."),
        ("project", "The Quartz vault project tracks ideas."),
        ("kitchen", "The kitchen window faces the garden."),
        ("harbor", "Harbor notes mention the evening tide."),
        ("ink", "Indigo ink stains the field notebook."),
        ("route", "The route from home to the studio is short."),
        ("cedar", "Cedar shelves hold the paper drafts."),
        ("nova", "Nova Park sketches interface ideas."),
        ("lumen", "Lumen Lab prototypes the quiet timer."),
        ("oriole", "Oriole writes the weekly review."),
        ("pebble", "Pebble keeps a list of open questions."),
        ("maple", "Maple Street studio stores the backups."),
        ("quartz-link", "See [[projects/quartz]] for the vault plan."),
        ("quartz", "The missing project note is the vault plan."),
        ("delta", "Delta compares two recall arms."),
        ("ember", "Ember lists people projects and paths."),
        ("fjord", "Fjord collects paraphrases of older notes."),
        ("grove", "Grove tags each idea with a short name."),
        ("helix", "Helix remembers Windows paths exactly."),
        ("iris", "Iris Chen aliases the Alice Chen note."),
        ("juniper", "Juniper files the Obsidian export."),
        ("kite", "Kite links a typo back to Zephyr."),
        ("lotus", "Lotus keeps the nonsense query from crashing."),
        ("moss", "Moss records that Bob Nguyen prefers Portland."),
        ("nectar", "Nectar describes the morning pages habit."),
        ("opal", "Opal stores F:\\Development\\maia as a reference."),
    ]
}

#[test]
fn live_recall_export_and_autolink_on_a_temp_database() {
    let (directory, store) = open_temp("seed");
    store
        .append(AppendEvents {
            thread_id: "thread-1".to_owned(),
            expected_version: 0,
            participants: "owner".to_owned(),
            occurred_at: NOW,
            events: vec![ThreadEventWrite {
                event_id: "event-1".to_owned(),
                kind: "user".to_owned(),
                body: "seed".to_owned(),
            }],
        })
        .expect("thread");
    let notes = sentences();
    let body = notes
        .iter()
        .map(|(_, sentence)| *sentence)
        .collect::<Vec<_>>()
        .join(" ");
    store
        .insert_episode(EpisodeWrite {
            episode_id: "episode-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            turn_id: "turn-1".to_owned(),
            body,
            taint: MemoryTaint::Trusted,
            reasoning: None,
            participants: "owner".to_owned(),
            created_at: NOW,
            segments: vec![],
        })
        .expect("episode");
    let claims = notes
        .iter()
        .map(|(id, sentence)| PromotionClaimWrite {
            claim_id: if *id == "quartz" {
                "projects/quartz".to_owned()
            } else {
                format!("claim-{id}")
            },
            sentence: (*sentence).to_owned(),
            taint: if *id == "path" {
                MemoryTaint::Untrusted
            } else {
                MemoryTaint::Trusted
            },
            valid_from: NOW,
            lexemes: note_lexemes(sentence),
        })
        .collect::<Vec<_>>();
    store
        .apply_promotion(PromotionWrite {
            episode_id: "episode-1".to_owned(),
            model: "model-a".to_owned(),
            now: NOW + 1,
            claims,
            same_claim_ids: vec![],
            replacements: vec![],
            links: vec![],
        })
        .expect("promotion");
    store
        .apply_consolidation(ConsolidationWrite {
            batch_id: "batch-1".to_owned(),
            now: NOW + 2,
            context_taint: MemoryTaint::Trusted,
            model: "model-a".to_owned(),
            entities: vec![],
            facts: vec![FactWrite {
                fact_id: "fact-portland".to_owned(),
                sentence: "Bob Nguyen lives in Portland.".to_owned(),
                entity_id: None,
                sources: "episode-1".to_owned(),
                valid_from: NOW + 2,
                claim_ids: vec!["claim-bob".to_owned()],
                episode_ids: vec!["episode-1".to_owned()],
            }],
            supersede: vec![SupersedeWrite {
                claim_id: "claim-bob".to_owned(),
                fact_id: "fact-portland".to_owned(),
            }],
            merges: vec![],
            closures: vec![],
            dismissals: vec![],
            proposals: vec![],
            consumed_queue_ids: vec![],
            release_holds: vec![],
            projection_entities: vec![],
            projection_folders: vec![],
        })
        .expect("consolidation");

    let queries = [
        "Alice Chen",
        "Zephyr",
        r"F:\Development\Ideas",
        "Zephir",
        "where does Bob live",
        "xqzvblort",
        "Quartz vault",
        "morning pages",
        "Obsidian",
        "indigo token",
    ];
    println!("live-check database=temp port=in-process spare=4187");
    println!("query\tkeyword\tvector\tgraph\ttop3");
    for query in queries {
        let run = recall_run(&store, query, Timestamp(NOW + 3), None);
        let top = run
            .packed
            .as_ref()
            .map(|packed| {
                packed
                    .items
                    .iter()
                    .take(3)
                    .map(|item| item.sentence.replace('\t', " "))
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .unwrap_or_default();
        println!(
            "{query}\t{}\t{}\t{}\t{top}",
            run.keyword, run.vector, run.graph
        );
    }

    let exported = directory.join("export");
    let report = store
        .export_brain_markdown(&exported, NOW + 4)
        .expect("export");
    println!("export neurons={} edges={}", report.neurons, report.edges);
    assert!(report.neurons >= 30, "seeded {}", report.neurons);

    let (import_dir, imported) = open_temp("import");
    let again = imported
        .import_brain_markdown(&exported, NOW + 5)
        .expect("import");
    println!("import neurons={} edges={}", again.neurons, again.edges);
    assert_eq!(again.neurons, report.neurons);
    assert_eq!(again.edges, report.edges);
    let original = store.search_neurons("Alice Chen", 5).expect("search");
    let copied = imported.search_neurons("Alice Chen", 5).expect("search");
    assert_eq!(
        original
            .iter()
            .map(|hit| hit.id.clone())
            .collect::<Vec<_>>(),
        copied.iter().map(|hit| hit.id.clone()).collect::<Vec<_>>()
    );

    let links = store.relink_neurons().expect("relink");
    println!("autolink edges={} pending={}", links.edges, links.pending);
    for (kind, count) in &links.by_type {
        println!("autolink {kind}={count}");
    }
    assert!(links.edges >= 1 || links.pending >= 1);

    imported.shutdown().expect("shutdown import");
    store.shutdown().expect("shutdown");
    let _ = fs::remove_dir_all(&directory);
    let _ = fs::remove_dir_all(&import_dir);
}
