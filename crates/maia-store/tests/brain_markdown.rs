//! Markdown round trip, keyword recall, and model-free links on temp databases.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use maia_core::agents::AgentId;
use maia_core::audit::Timestamp;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::NeuronDoc;
use maia_core::brain::PageRankParams;
use maia_core::brain::RankPolicy;
use maia_core::brain::RecallQuery;
use maia_core::brain::RecallTaintMode;
use maia_core::brain::ScoreWeights;
use maia_core::brain::graph_from_docs;
use maia_core::brain::parse_neuron;
use maia_core::brain::rank_paths;
use maia_core::credit::AgeUnit;
use maia_store::AppendEvents;
use maia_store::ConsolidationWrite;
use maia_store::EpisodeWrite;
use maia_store::FactRevise;
use maia_store::FactWrite;
use maia_store::LATEST_SCHEMA_VERSION;
use maia_store::MemoryTaint;
use maia_store::OwnerOpen;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;
use maia_store::SupersedeWrite;
use maia_store::ThreadEventWrite;

struct TestDb {
    directory: PathBuf,
    owner: Option<SqliteOwner>,
}

impl TestDb {
    fn open(name: &str) -> Self {
        let directory =
            std::env::temp_dir().join(format!("maia-brain-md-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("{error}"));
        let owner = SqliteOwner::open(OwnerOpen {
            path: directory.join("brain.sqlite"),
            now: 1,
            normal_capacity: 8,
            panic_capacity: 2,
        })
        .unwrap_or_else(|error| panic!("{error}"));
        Self {
            directory,
            owner: Some(owner),
        }
    }

    fn owner(&self) -> &SqliteOwner {
        match &self.owner {
            Some(owner) => owner,
            None => panic!("owner shut down"),
        }
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        if let Some(owner) = self.owner.take() {
            let _ = owner.shutdown();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn must<T>(result: Result<T, StoreError>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => panic!("{error}"),
    }
}

fn seed_thread(owner: &SqliteOwner) {
    must(owner.append(AppendEvents {
        thread_id: "thread-1".to_owned(),
        expected_version: 0,
        participants: "owner".to_owned(),
        occurred_at: 10,
        events: vec![ThreadEventWrite {
            event_id: "event-1".to_owned(),
            kind: "user".to_owned(),
            body: "remember the path".to_owned(),
        }],
    }));
}

fn episode(body: &str, taint: MemoryTaint) -> EpisodeWrite {
    EpisodeWrite {
        episode_id: "episode-1".to_owned(),
        thread_id: "thread-1".to_owned(),
        turn_id: "turn-1".to_owned(),
        body: body.to_owned(),
        taint,
        reasoning: None,
        participants: "owner".to_owned(),
        created_at: 20,
        segments: vec![],
    }
}

fn claim(id: &str, sentence: &str, taint: MemoryTaint, lexemes: &[&str]) -> PromotionClaimWrite {
    PromotionClaimWrite {
        claim_id: id.to_owned(),
        sentence: sentence.to_owned(),
        taint,
        valid_from: 20,
        lexemes: lexemes.iter().map(|lexeme| (*lexeme).to_owned()).collect(),
        ..Default::default()
    }
}

fn promote(owner: &SqliteOwner, claims: Vec<PromotionClaimWrite>) {
    must(owner.apply_promotion(PromotionWrite {
        episode_id: "episode-1".to_owned(),
        model: "model-a".to_owned(),
        now: 30,
        claims,
        same_claim_ids: vec![],
        replacements: vec![],
        links: vec![],
    }));
}

fn consolidate(owner: &SqliteOwner, sentence: &str) {
    must(owner.apply_consolidation(ConsolidationWrite {
        batch_id: "batch-1".to_owned(),
        now: 40,
        context_taint: MemoryTaint::Trusted,
        model: "model-a".to_owned(),
        entities: vec![],
        facts: vec![FactWrite {
            fact_id: "fact-1".to_owned(),
            sentence: sentence.to_owned(),
            entity_id: None,
            sources: "episode-1".to_owned(),
            valid_from: 40,
            claim_ids: vec!["claim-old".to_owned()],
            episode_ids: vec!["episode-1".to_owned()],
        }],
        supersede: vec![SupersedeWrite {
            claim_id: "claim-old".to_owned(),
            fact_id: "fact-1".to_owned(),
        }],
        merges: vec![],
        closures: vec![],
        dismissals: vec![],
        proposals: vec![],
        consumed_queue_ids: vec![],
        release_holds: vec![],
        projection_entities: vec![],
        projection_folders: vec![],
    }));
}

#[test]
fn schema_version_is_twelve() {
    assert_eq!(LATEST_SCHEMA_VERSION, 18);
}

#[test]
fn keyword_arm_finds_names_and_windows_paths_without_an_embedder() {
    let db = TestDb::open("keyword");
    seed_thread(db.owner());
    must(db.owner().insert_episode(episode(
        "See [[projects/missing]] and F:\\Development\\Ideas and Zephyr.",
        MemoryTaint::Untrusted,
    )));
    promote(
        db.owner(),
        vec![claim(
            "claim-path",
            "Notes live at F:\\Development\\Ideas.",
            MemoryTaint::Trusted,
            &["notes", "ideas"],
        )],
    );
    let by_name = must(db.owner().search_neurons("Ideas", 8));
    assert!(by_name.iter().any(|hit| hit.id == "claim-path"));
    let by_path = must(db.owner().search_neurons(r"F:\Development\Ideas", 8));
    assert!(by_path.iter().any(|hit| hit.id == "claim-path"));
    let odd = must(db.owner().search_neurons("*** OR ( \"", 8));
    assert!(odd.is_empty());
    let before = must(db.owner().thread("thread-1"));
    let hit = match by_name.iter().find(|item| item.id == "claim-path") {
        Some(hit) => hit,
        None => panic!("missing claim-path"),
    };
    assert_eq!(hit.taint, "trusted");
    let _ = must(db.owner().search_neurons("Ideas", 8));
    assert_eq!(must(db.owner().thread("thread-1")).version, before.version);
}

#[test]
fn keyword_arm_matches_plurals_and_verb_tenses() {
    let db = TestDb::open("stem");
    seed_thread(db.owner());
    must(db.owner().insert_episode(episode(
        "Bob lives in Portland. Carol goes to Seattle. The box sits on the shelf. A person wrote the note. Sam bought the ticket.",
        MemoryTaint::Trusted,
    )));
    promote(
        db.owner(),
        vec![
            claim(
                "claim-bob",
                "Bob lives in Portland.",
                MemoryTaint::Trusted,
                &["bob", "portland"],
            ),
            claim(
                "claim-carol",
                "Carol goes to Seattle.",
                MemoryTaint::Trusted,
                &["carol", "seattle"],
            ),
            claim(
                "claim-box",
                "The box sits on the shelf.",
                MemoryTaint::Trusted,
                &["box", "shelf"],
            ),
            claim(
                "claim-person",
                "A person wrote the note.",
                MemoryTaint::Trusted,
                &["person", "note"],
            ),
            claim(
                "claim-buy",
                "Sam bought the ticket.",
                MemoryTaint::Trusted,
                &["sam", "ticket"],
            ),
        ],
    );
    let find = |query: &str, id: &str| {
        let hits = must(db.owner().search_neurons(query, 8));
        assert!(
            hits.iter().any(|hit| hit.id == id),
            "{query} missed {id}: {hits:?}"
        );
    };
    find("where does Bob live", "claim-bob");
    find("who went to Seattle", "claim-carol");
    find("boxes", "claim-box");
    find("people", "claim-person");
    find("will buy", "claim-buy");
}

#[test]
fn keyword_index_follows_body_edits_and_soft_deletes() {
    let db = TestDb::open("edit");
    seed_thread(db.owner());
    must(
        db.owner()
            .insert_episode(episode("Zephyr keeps a path.", MemoryTaint::Trusted)),
    );
    promote(
        db.owner(),
        vec![claim(
            "claim-path",
            "Zephyr keeps F:\\Development\\Ideas.",
            MemoryTaint::Trusted,
            &["zephyr"],
        )],
    );
    let dir = db.directory.join("md");
    must(db.owner().export_brain_markdown(&dir, 100));
    let file = dir
        .join("claim")
        .join("zephyr-keeps-f-development-ideas--claim-path.md");
    let text = fs::read_to_string(&file).unwrap_or_else(|error| panic!("{error}"));
    let edited = rewrite_updated_at(
        &text.replace(
            "Zephyr keeps F:\\Development\\Ideas.",
            "Quartz keeps the vault.",
        ),
        500,
    );
    fs::write(&file, edited).unwrap_or_else(|error| panic!("{error}"));
    must(db.owner().sync_brain_markdown(&dir, 500));
    let quartz = must(db.owner().search_neurons("Quartz", 8));
    assert!(quartz.iter().any(|hit| hit.id == "claim-path"));
    assert!(
        must(db.owner().search_neurons("Zephyr", 8))
            .iter()
            .all(|hit| hit.id != "claim-path")
    );
    fs::remove_file(&file).unwrap_or_else(|error| panic!("{error}"));
    must(db.owner().sync_brain_markdown(&dir, 600));
    assert!(
        must(db.owner().search_neurons("Quartz", 8))
            .iter()
            .all(|hit| hit.id != "claim-path")
    );
}

fn rewrite_updated_at(text: &str, stamp: i64) -> String {
    let mut lines = Vec::new();
    for line in text.lines() {
        if line.starts_with("updated_at:") {
            lines.push(format!("updated_at: {stamp}"));
        } else {
            lines.push(line.to_owned());
        }
    }
    lines.join("\n") + "\n"
}

#[test]
fn export_import_round_trip_keeps_rank_inputs() {
    let db = TestDb::open("round");
    seed_thread(db.owner());
    must(db.owner().insert_episode(episode(
        "Bob used Obsidian. Bob lives in Portland.",
        MemoryTaint::Trusted,
    )));
    promote(
        db.owner(),
        vec![
            claim(
                "claim-old",
                "Bob used Obsidian.",
                MemoryTaint::Trusted,
                &["bob", "obsidian"],
            ),
            claim(
                "claim-new",
                "Bob lives in Portland.",
                MemoryTaint::Untrusted,
                &["bob", "portland"],
            ),
        ],
    );
    consolidate(db.owner(), "Bob lives in Portland.");
    let exported = db.directory.join("export");
    must(db.owner().export_brain_markdown(&exported, 50));
    let fresh = TestDb::open("round-import");
    must(fresh.owner().import_brain_markdown(&exported, 60));
    let again = fresh.directory.join("again");
    must(fresh.owner().export_brain_markdown(&again, 70));
    let left = docs_in(&exported);
    let right = docs_in(&again);
    assert_eq!(left.len(), right.len());
    for (before, after) in left.iter().zip(right.iter()) {
        assert_eq!(before.id, after.id);
        assert_eq!(before.kind, after.kind);
        assert_eq!(before.body, after.body);
        assert_eq!(before.taint, after.taint);
        assert_eq!(before.status, after.status);
        assert_eq!(before.consolidated_by, after.consolidated_by);
        assert_eq!(before.edges, after.edges);
    }
    let policy = RankPolicy {
        decay: 0.5,
        age_unit: AgeUnit::Seconds,
        lexical: LexicalPolicy {
            stopwords: BTreeSet::from(["the".to_owned()]),
            fan_out: std::collections::BTreeMap::new(),
            high_fan_cutoff: 100,
        },
        pagerank: PageRankParams {
            damping: 0.5,
            iterations: 2,
        },
        weights: ScoreWeights {
            activation: 0.0,
            pagerank: 1.0,
            embedding: 0.0,
        },
        inclusion_threshold: 0.0,
        recall_token_budget: 400,
        taint_mode: RecallTaintMode::IncludeUntrusted,
    };
    let query = RecallQuery {
        text: "portland".to_owned(),
        embedding: None,
    };
    let (graph_left, quarantine_left) = graph_from_docs(&left);
    let (graph_right, quarantine_right) = graph_from_docs(&right);
    let rank_left = rank_paths(
        &graph_left,
        &query,
        Timestamp(100),
        &policy,
        &quarantine_left,
        &BTreeSet::<AgentId>::new(),
    )
    .unwrap_or_else(|error| panic!("{error:?}"));
    let rank_right = rank_paths(
        &graph_right,
        &query,
        Timestamp(100),
        &policy,
        &quarantine_right,
        &BTreeSet::<AgentId>::new(),
    )
    .unwrap_or_else(|error| panic!("{error:?}"));
    let left_ids: Vec<String> = rank_left
        .iter()
        .map(|row| row.scores.tie_break.clone())
        .collect();
    let right_ids: Vec<String> = rank_right
        .iter()
        .map(|row| row.scores.tie_break.clone())
        .collect();
    assert_eq!(left_ids, right_ids);
    assert!(left_ids.iter().any(|id| id.contains("fact-1")));
    assert!(left_ids.iter().all(|id| !id.contains("claim-old")));
    let untrusted = match right.iter().find(|doc| doc.id == "claim-new") {
        Some(doc) => doc,
        None => panic!("claim-new"),
    };
    assert_eq!(untrusted.taint, "untrusted");
}

fn docs_in(dir: &Path) -> Vec<NeuronDoc> {
    let mut docs = Vec::new();
    for kind in ["episode", "claim", "fact"] {
        let folder = dir.join(kind);
        if !folder.exists() {
            continue;
        }
        let mut names = fs::read_dir(&folder)
            .unwrap_or_else(|error| panic!("{error}"))
            .map(|entry| entry.unwrap_or_else(|error| panic!("{error}")).path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .collect::<Vec<_>>();
        names.sort();
        for path in names {
            let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("{error}"));
            docs.push(parse_neuron(&text).unwrap_or_else(|error| panic!("{}", error.message)));
        }
    }
    docs.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.id.cmp(&right.id)));
    docs
}

#[test]
fn auto_link_is_idempotent_pending_then_resolved_and_tainted() {
    let db = TestDb::open("links");
    seed_thread(db.owner());
    must(db.owner().insert_episode(episode(
        "See [[projects/missing]] and Zephyr today.",
        MemoryTaint::Untrusted,
    )));
    promote(
        db.owner(),
        vec![claim(
            "claim-zephyr",
            "Zephyr keeps the notes.",
            MemoryTaint::Trusted,
            &["zephyr"],
        )],
    );
    let first = must(db.owner().relink_neurons());
    let second = must(db.owner().relink_neurons());
    assert_eq!(first.edges, second.edges);
    assert!(
        first
            .by_type
            .iter()
            .any(|(kind, count)| kind == "pending" && *count >= 1)
    );
    let dir = db.directory.join("md");
    must(db.owner().export_brain_markdown(&dir, 80));
    let created = "---\nid: \"projects/missing\"\nkind: \"claim\"\nupdated_at: 90\nsource_episode: \"episode-1\"\ntaint: \"trusted\"\n---\nThe missing project note.\n";
    fs::create_dir_all(dir.join("claim")).unwrap_or_else(|error| panic!("{error}"));
    fs::write(dir.join("claim").join("missing.md"), created)
        .unwrap_or_else(|error| panic!("{error}"));
    must(db.owner().sync_brain_markdown(&dir, 90));
    let resolved = must(db.owner().relink_neurons());
    assert!(
        resolved
            .by_type
            .iter()
            .any(|(kind, count)| kind == "wikilink" && *count >= 1)
    );
    let check = db.directory.join("check");
    must(db.owner().export_brain_markdown(&check, 100));
    let episode_doc = match docs_in(&check)
        .into_iter()
        .find(|doc| doc.id == "episode-1")
    {
        Some(doc) => doc,
        None => panic!("missing episode"),
    };
    let link = match episode_doc
        .edges
        .iter()
        .find(|edge| edge.edge_type == "wikilink" && edge.to_id == "projects/missing")
    {
        Some(edge) => edge,
        None => panic!("missing wikilink"),
    };
    assert_eq!(link.taint, "untrusted");
    let target = must(db.owner().search_neurons("missing project", 8));
    assert!(
        target
            .iter()
            .any(|hit| hit.id == "projects/missing" && hit.taint == "trusted")
    );
}

#[test]
fn sync_keeps_the_newer_database_sentence() {
    let db = TestDb::open("conflict");
    seed_thread(db.owner());
    must(
        db.owner()
            .insert_episode(episode("Bob used Obsidian.", MemoryTaint::Trusted)),
    );
    promote(
        db.owner(),
        vec![claim(
            "claim-old",
            "Bob used Obsidian.",
            MemoryTaint::Trusted,
            &["bob"],
        )],
    );
    consolidate(db.owner(), "Bob used Obsidian.");
    let dir = db.directory.join("md");
    must(db.owner().export_brain_markdown(&dir, 50));
    must(db.owner().revise_fact(FactRevise {
        fact_id: "fact-1".to_owned(),
        sentence: "Database copy stays.".to_owned(),
        lexemes: vec!["database".to_owned()],
    }));
    let file = dir.join("fact").join("bob-used-obsidian--fact-1.md");
    let text = fs::read_to_string(&file).unwrap_or_else(|error| panic!("{error}"));
    fs::write(
        &file,
        text.replace("Bob used Obsidian.", "File copy loses."),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let report = must(db.owner().sync_brain_markdown(&dir, 80));
    assert!(
        report
            .conflicts
            .iter()
            .any(|conflict| conflict.id == "fact-1")
    );
    let hits = must(db.owner().search_neurons("Database", 8));
    assert!(hits.iter().any(|hit| hit.id == "fact-1"));
}
