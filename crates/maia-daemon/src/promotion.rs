//! Background episode promotion. Never blocks the owner's reply path.
//!
//! The runner validates model JSON, copies taint from the episode, and applies
//! claims in one store transaction. Invalid output queues a retry and writes
//! nothing partial. Embeddings are written after that commit and may be absent.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use maia_core::audit::RequestId;
use maia_core::audit::Timestamp;
use maia_core::brain::ClaimId;
use maia_core::brain::EmbedderModel;
use maia_core::brain::EpisodeId;
use maia_core::brain::LexicalPolicy;
use maia_core::brain::QueryEmbedding;
use maia_core::brain::RRF_K;
use maia_core::brain::RecallGraph;
use maia_core::brain::StoredEmbedding;
use maia_core::brain::lexemes_for_sentence;
use maia_core::brain::reciprocal_rank_fusion;
use maia_core::brain::same_keyword_term;
use maia_core::dream::ApplyFault;
use maia_core::dream::ClaimSeed;
use maia_core::dream::DEFAULT_PROMOTION_FAILURE_LIMIT;
use maia_core::dream::EntitySlug;
use maia_core::dream::EpisodeSegment;
use maia_core::dream::ModelIdentity;
use maia_core::dream::PromotionEpisode;
use maia_core::dream::RELATEDNESS_FANOUT;
use maia_core::dream::RelatedCandidate;
use maia_core::dream::describe_promotion_decision;
use maia_core::dream::merge_claim_seeds;
use maia_core::dream::parse_promotion_decision;
use maia_core::dream::promotion_backoff_seconds;
use maia_core::dream::promotion_claim_id;
use maia_core::dream::select_entity_links;
use maia_core::dream::select_related_claims;
use maia_core::dream::should_skip_promotion;
use maia_core::embedder::BGE_SMALL_EN_V1_5;
use maia_core::embedder::EmbedderArtifacts;
use maia_core::embedder::EmbedderModelSpec;
use maia_core::router::CanonicalJson;
use maia_core::router::ReasoningEffort;
use maia_core::router::Router;
use maia_core::router::RouterError;
use maia_core::router::RouterRequest;
use maia_core::router::RouterResponse;
use maia_core::router::RouterUsage;
use maia_core::router::UsageValue;
use maia_core::router::classify_router_failure;
use maia_core::security::SourceRef;
use maia_core::security::Taint;
use maia_core::thread_cache::ChatMessage;
use maia_core::thread_cache::ChatRole;
use maia_embedder::CandleEmbedder;
use maia_store::EmbeddingModelWrite;
use maia_store::EmbeddingTarget;
use maia_store::EmbeddingWrite;
use maia_store::MemoryTaint;
use maia_store::NearestClaimRow;
use maia_store::PromotionClaimWrite;
use maia_store::PromotionLinkWrite;
use maia_store::PromotionReplaceWrite;
use maia_store::PromotionWrite;
use maia_store::SqliteOwner;
use maia_store::StoreError;

use crate::promoter_env::DEFAULT_PROMOTER_DAILY_CALL_CAP;
use crate::promoter_env::DEFAULT_PROMOTER_DAILY_TOKEN_CAP;

const NEAREST_CLAIM_LIMIT: i64 = 5;
/// One promoter HTTP call is abandoned after this long. A 74s outlier becomes a retry.
pub const PROMOTER_CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// Fast transport failures tried inside one episode selection.
pub const PROMOTER_FAST_ATTEMPTS: u32 = 3;
const DEFAULT_LEXICAL: fn() -> LexicalPolicy = || LexicalPolicy {
    stopwords: BTreeSet::from([
        "a".to_owned(),
        "an".to_owned(),
        "the".to_owned(),
        "is".to_owned(),
        "are".to_owned(),
        "to".to_owned(),
        "of".to_owned(),
        "and".to_owned(),
        "or".to_owned(),
        "for".to_owned(),
        "in".to_owned(),
        "on".to_owned(),
        "at".to_owned(),
    ]),
    fan_out: BTreeMap::new(),
    high_fan_cutoff: 100,
};

/// Why one promotion attempt did not commit claims.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromotionAttempt {
    /// Episode was code-skipped or model-skipped and marked promoted.
    Skipped,
    /// Claims were written.
    Applied {
        /// New claim ids.
        claim_ids: Vec<String>,
    },
    /// Episode stays pending and was counted as a failure.
    QueuedRetry,
    /// Daily ceiling blocked the call.
    CapReached,
    /// Nothing pending, or every pending episode is waiting out backoff.
    Idle,
}

/// Bounds for one promoter completion.
#[derive(Debug, Clone, Copy)]
pub struct CallLimits {
    /// Maximum wait for one HTTP attempt.
    pub timeout: Duration,
    /// Fast failures attempted before the episode is deferred.
    pub attempts: u32,
    /// Delay before a fast retry. Doubles each time, capped at 2 seconds.
    pub backoff: Duration,
}

/// One promoter completion, including HTTP attempts that failed.
#[derive(Debug)]
pub struct ModelTurn {
    /// HTTP attempts made. Timeouts are not retried.
    pub calls: u32,
    /// Model text and usage, or a redacted failure note.
    pub body: Result<(String, RouterUsage), String>,
}

/// Fake or live promoter model.
pub trait PromoterModel: Send {
    /// One tool-less chat completion.
    fn complete(&mut self, prompt: &str, limits: CallLimits) -> ModelTurn;
}

/// Scripted promoter for tests. Replies are returned in push order.
#[derive(Default)]
pub struct ScriptedPromoter {
    replies: VecDeque<Result<String, String>>,
    /// Prompts observed by the script, oldest first.
    pub prompts: Vec<String>,
}

impl ScriptedPromoter {
    /// Builds an empty script.
    pub fn create() -> Self {
        Self::default()
    }

    /// Queues one successful JSON body.
    pub fn push_ok(&mut self, body: impl Into<String>) {
        self.replies.push_back(Ok(body.into()));
    }

    /// Queues one model failure.
    pub fn push_err(&mut self, detail: impl Into<String>) {
        self.replies.push_back(Err(detail.into()));
    }
}

impl PromoterModel for ScriptedPromoter {
    fn complete(&mut self, prompt: &str, _limits: CallLimits) -> ModelTurn {
        self.prompts.push(prompt.to_owned());
        let body = self
            .replies
            .pop_front()
            .unwrap_or_else(|| Err("promoter script empty".to_owned()))
            .map(|text| {
                (
                    text,
                    RouterUsage {
                        input_tokens: UsageValue::Reported(32),
                        output_tokens: UsageValue::Reported(16),
                        cached_input_tokens: UsageValue::Unavailable,
                    },
                )
            });
        ModelTurn { calls: 1, body }
    }
}

/// Live OpenAI-compatible promoter over a [`Router`].
pub struct RouterPromoter<R> {
    router: R,
    model: String,
    request_seq: AtomicU64,
}

impl<R> RouterPromoter<R> {
    /// Wraps a router transport for promotion calls.
    pub fn new(router: R, model: impl Into<String>) -> Self {
        Self {
            router,
            model: model.into(),
            request_seq: AtomicU64::new(1),
        }
    }
}

impl<R: Router + Send> PromoterModel for RouterPromoter<R> {
    fn complete(&mut self, prompt: &str, limits: CallLimits) -> ModelTurn {
        let seq = self.request_seq.fetch_add(1, Ordering::Relaxed);
        let request = RouterRequest {
            request_id: RequestId(seq),
            model: self.model.clone(),
            messages: vec![
                ChatMessage::text(ChatRole::System, PROMOTER_SYSTEM),
                ChatMessage::text(ChatRole::User, prompt.to_owned()),
            ],
            tools_json: CanonicalJson("[]".to_owned()),
            prefix_hash: maia_core::credit::PrefixHash::new("promoter"),
            recall_hash: None,
            reasoning_effort: ReasoningEffort::Low,
            prior_provider_tool_state: None,
        };
        let attempts = limits.attempts.max(1);
        let mut calls = 0u32;
        let mut last = "promoter call failed".to_owned();
        let mut backoff = limits.backoff;
        for attempt in 0..attempts {
            if attempt > 0 {
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(Duration::from_secs(2));
            }
            calls = calls.saturating_add(1);
            match block_on_timeout(limits.timeout, self.router.complete(&request)) {
                Err(note) => {
                    return ModelTurn {
                        calls,
                        body: Err(note),
                    };
                }
                Ok(Timed::Expired) => {
                    return ModelTurn {
                        calls,
                        body: Err("promoter timeout".to_owned()),
                    };
                }
                Ok(Timed::Ready(Ok(response))) => {
                    return ModelTurn {
                        calls,
                        body: Ok((response_text(&response), response.usage)),
                    };
                }
                Ok(Timed::Ready(Err(error))) => last = redact_router_error(&error),
            }
        }
        ModelTurn {
            calls,
            body: Err(last),
        }
    }
}

const PROMOTER_SYSTEM: &str = "You extract provisional memory claims from one episode. \
Respond with one JSON object only: {\"skip\":bool,\"new\":[sentence],\"same\":[claim_id],\"replaces\":[{\"old\":claim_id,\"sentence\":sentence}]}. \
Each sentence is one declarative sentence ending in a single period. \
Use same when a nearest claim already says the fact. Use replaces when a nearest claim is corrected. \
Use skip true for greetings and chatter with no durable fact. \
Keep only durable facts about the owner: identity, location, preferences, people, devices, projects, folders, accounts, decisions, and standing instructions. \
Do not keep status lines, your own actions, or one-off task requests. \
No extra fields and no tools. A code fence or short preamble around that one JSON object is ignored.";

/// Embedder identity recorded beside claim vectors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimEmbedderIdentity {
    /// Model id stored on the vector row.
    pub model_id: String,
    /// Vector width. v1 is 384.
    pub dimensions: u64,
    /// Weight digest recorded with the model.
    pub weights_sha256: String,
    /// Tokenizer digest recorded with the model.
    pub tokenizer_sha256: String,
    /// Query prefix stored with the model.
    pub query_prefix: String,
    /// Document prefix stored with the model.
    pub document_prefix: String,
}

/// Why claim vectors were not written. The note never includes a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedFailure {
    /// The embedder is missing, incompatible, or refused the texts.
    Unavailable,
}

/// Local claim embedder. Failures leave claims findable by text and lexeme.
pub trait ClaimEmbedder: Send + Sync {
    /// Model identity written with every vector from this embedder.
    fn identity(&self) -> ClaimEmbedderIdentity;
    /// Embeds each text. One vector per input, in order.
    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure>;
}

/// Deterministic embedder used by tests and fixtures.
pub struct CoreClaimEmbedder {
    spec: EmbedderModelSpec,
    inner: maia_core::embedder::DeterministicFakeEmbedder,
}

impl CoreClaimEmbedder {
    /// Builds the fake embedder for one pinned spec.
    pub fn new(spec: &EmbedderModelSpec) -> Self {
        Self {
            spec: spec.clone(),
            inner: maia_core::embedder::DeterministicFakeEmbedder::new(spec),
        }
    }
}

impl ClaimEmbedder for CoreClaimEmbedder {
    fn identity(&self) -> ClaimEmbedderIdentity {
        identity_from_spec(&self.spec)
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        let embedded = self
            .inner
            .embed_sync(texts)
            .map_err(|_| EmbedFailure::Unavailable)?;
        Ok(embedded
            .into_iter()
            .map(|item| item.values.into_iter().map(|value| value as f32).collect())
            .collect())
    }
}

/// Candle embedder adapter. Inference that is not ready degrades to no vectors.
pub struct CandleClaimEmbedder {
    inner: CandleEmbedder,
}

impl CandleClaimEmbedder {
    /// Wraps an opened Candle embedder.
    pub fn new(inner: CandleEmbedder) -> Self {
        Self { inner }
    }
}

impl ClaimEmbedder for CandleClaimEmbedder {
    fn identity(&self) -> ClaimEmbedderIdentity {
        identity_from_spec(&BGE_SMALL_EN_V1_5)
    }

    fn embed(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedFailure> {
        if !self.inner.inference_is_production_ready() {
            return Err(EmbedFailure::Unavailable);
        }
        let embedded = self
            .inner
            .embed_sync(texts)
            .map_err(|_| EmbedFailure::Unavailable)?;
        Ok(embedded
            .into_iter()
            .map(|item| item.values.into_iter().map(|value| value as f32).collect())
            .collect())
    }
}

/// Opens the local Candle embedder when the pinned artifacts verify.
///
/// A missing file or a digest mismatch returns `None`. The value is not logged.
pub fn open_candle_claim_embedder(
    weights_dir: &str,
    tokenizer_path: &str,
) -> Option<Arc<dyn ClaimEmbedder>> {
    let artifacts = EmbedderArtifacts {
        weights_dir: weights_dir.to_owned(),
        tokenizer_path: tokenizer_path.to_owned(),
    };
    let inner = CandleEmbedder::open(&artifacts, &BGE_SMALL_EN_V1_5).ok()?;
    Some(Arc::new(CandleClaimEmbedder::new(inner)))
}

fn identity_from_spec(spec: &EmbedderModelSpec) -> ClaimEmbedderIdentity {
    ClaimEmbedderIdentity {
        model_id: spec.model_id.to_owned(),
        dimensions: u64::try_from(spec.dimensions).unwrap_or(0),
        weights_sha256: spec.weight_sha256.to_owned(),
        tokenizer_sha256: spec.tokenizer_sha256.to_owned(),
        query_prefix: spec.vector_prefix.to_owned(),
        document_prefix: spec.vector_prefix.to_owned(),
    }
}

/// Promotion policy ceilings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromotionCaps {
    /// Max promotion calls per UTC day.
    pub daily_call_cap: u32,
    /// Max tokens per UTC day.
    pub daily_token_cap: u64,
    /// Failures before quarantine.
    pub failure_limit: u32,
}

impl Default for PromotionCaps {
    fn default() -> Self {
        Self {
            daily_call_cap: DEFAULT_PROMOTER_DAILY_CALL_CAP,
            daily_token_cap: DEFAULT_PROMOTER_DAILY_TOKEN_CAP,
            failure_limit: DEFAULT_PROMOTION_FAILURE_LIMIT,
        }
    }
}

/// Runs pending promotions against a store and promoter.
pub struct PromotionRunner<P> {
    store: SqliteOwner,
    promoter: Arc<Mutex<P>>,
    model_name: String,
    caps: PromotionCaps,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    embedder: Option<Arc<dyn ClaimEmbedder>>,
    deferred: Mutex<BTreeMap<String, i64>>,
}

impl<P: PromoterModel> PromotionRunner<P> {
    /// Builds a runner. `now` is injected; the runner does not read a clock.
    pub fn new(
        store: SqliteOwner,
        promoter: P,
        model_name: impl Into<String>,
        caps: PromotionCaps,
        now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            store,
            promoter: Arc::new(Mutex::new(promoter)),
            model_name: model_name.into(),
            caps,
            now,
            embedder: None,
            deferred: Mutex::new(BTreeMap::new()),
        }
    }

    /// Attaches the embedder used after a promotion commit and for recall seeding.
    pub fn with_embedder(mut self, embedder: Arc<dyn ClaimEmbedder>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    /// Shared store handle for tests and composition.
    pub fn store(&self) -> &SqliteOwner {
        &self.store
    }

    /// Promoter lock for scripted assertions.
    pub fn promoter(&self) -> Arc<Mutex<P>> {
        Arc::clone(&self.promoter)
    }

    /// Processes every pending episode oldest-first until idle or capped.
    pub fn drain(&self) -> Result<Vec<PromotionAttempt>, StoreError> {
        let mut out = Vec::new();
        loop {
            match self.promote_one()? {
                PromotionAttempt::Idle => break,
                PromotionAttempt::CapReached => {
                    out.push(PromotionAttempt::CapReached);
                    break;
                }
                other => out.push(other),
            }
        }
        Ok(out)
    }

    /// Promotes the oldest eligible episode, or returns Idle.
    pub fn promote_one(&self) -> Result<PromotionAttempt, StoreError> {
        let now = (self.now)();
        let Some(row) = self.next_pending(now)? else {
            return Ok(PromotionAttempt::Idle);
        };
        let day_key = day_key(now);
        let (calls, tokens) = self.store.promotion_day_stats(&day_key)?;
        if calls >= i64::from(self.caps.daily_call_cap)
            || tokens >= i64::try_from(self.caps.daily_token_cap).unwrap_or(i64::MAX)
        {
            return Ok(PromotionAttempt::CapReached);
        }
        let episode = self.store.promotion_episode(&row.episode_id)?;
        if should_skip_promotion(&episode.body).is_some() {
            self.store
                .mark_promotion_skipped(&episode.episode_id, now, &self.model_name)?;
            self.clear_defer(&episode.episode_id);
            return Ok(PromotionAttempt::Skipped);
        }
        let nearest = nearest_for_episode(&self.store, &episode.body, self.embedder.as_deref());
        let prompt = build_promoter_prompt(&episode.body, &nearest);
        let room = call_room(calls, self.caps.daily_call_cap);
        let turn = {
            let mut promoter = lock_mutex(&self.promoter);
            promoter.complete(
                &prompt,
                CallLimits {
                    timeout: PROMOTER_CALL_TIMEOUT,
                    attempts: room,
                    backoff: Duration::from_millis(200),
                },
            )
        };
        let (raw, usage) = match turn.body {
            Ok(value) => value,
            Err(_) => {
                self.account(&day_key, turn.calls, 0)?;
                return self.queue_retry(&episode.episode_id, now);
            }
        };
        self.account(&day_key, turn.calls, usage_total(&usage))?;
        let decision = match parse_promotion_decision(&raw) {
            Ok(decision) => decision,
            Err(_) => return self.queue_retry(&episode.episode_id, now),
        };
        if decision.skip {
            self.store
                .mark_promotion_skipped(&episode.episode_id, now, &self.model_name)?;
            self.clear_defer(&episode.episode_id);
            return Ok(PromotionAttempt::Skipped);
        }
        let shown: BTreeSet<ClaimId> = nearest
            .iter()
            .map(|claim| ClaimId::new(claim.claim_id.clone()))
            .collect();
        if decision.same.iter().any(|id| !shown.contains(id))
            || decision
                .replaces
                .iter()
                .any(|item| !shown.contains(&item.old))
        {
            return self.queue_retry(&episode.episode_id, now);
        }
        let mut decision = decision;
        reconcile_claims(&mut decision, &nearest);
        decision.replaces.retain(|item| {
            !self
                .store
                .claim_owner_edited(item.old.as_str())
                .unwrap_or(true)
        });
        if decision.new.is_empty() && decision.replaces.is_empty() && decision.same.is_empty() {
            self.store
                .mark_promotion_skipped(&episode.episode_id, now, &self.model_name)?;
            self.clear_defer(&episode.episode_id);
            return Ok(PromotionAttempt::Skipped);
        }
        let known = known_claim_ids(&self.store)?;
        let needed = decision.new.len() + decision.replaces.len();
        let new_ids = (0..needed)
            .map(|index| promotion_claim_id(&episode.episode_id, index))
            .collect::<Vec<_>>();
        let promotion_episode = PromotionEpisode {
            id: EpisodeId::new(episode.episode_id.clone()),
            at: Timestamp(episode.created_at),
            participants: BTreeSet::from([episode.participants.clone()]),
            segments: episode
                .segments
                .iter()
                .map(|segment| EpisodeSegment {
                    text: segment.text.clone(),
                    taint: store_taint(segment.taint),
                    sources: BTreeSet::from([SourceRef::OwnerMessage(0)]),
                })
                .collect(),
            reasoning: episode.reasoning.clone(),
            known_claim_ids: known,
        };
        let commit = match describe_promotion_decision(
            &promotion_episode,
            &decision,
            &new_ids,
            Timestamp(now),
            &ModelIdentity::new(self.model_name.clone()),
            &DEFAULT_LEXICAL(),
            ApplyFault::None,
        ) {
            Ok(commit) => commit,
            Err(_) => return self.queue_retry(&episode.episode_id, now),
        };
        let taint = episode_memory_taint(&episode);
        let claims: Vec<PromotionClaimWrite> = commit
            .claims
            .iter()
            .map(|claim| PromotionClaimWrite {
                claim_id: claim.id.as_str().to_owned(),
                sentence: claim.sentence.clone(),
                taint,
                valid_from: claim.valid_from.0,
                lexemes: claim
                    .lexemes
                    .iter()
                    .map(|lexeme| lexeme.as_str().to_owned())
                    .collect(),
            })
            .collect();
        let links = promotion_links(&self.store, &claims, &nearest, self.embedder.as_deref())?;
        let write = PromotionWrite {
            episode_id: episode.episode_id.clone(),
            model: self.model_name.clone(),
            now,
            claims,
            same_claim_ids: commit
                .same_mentions
                .iter()
                .map(|edge| edge.claim_id.as_str().to_owned())
                .collect(),
            replacements: commit
                .replacements
                .iter()
                .map(|item| PromotionReplaceWrite {
                    old_claim_id: item.old_claim_id.as_str().to_owned(),
                    new_claim_id: item.new_claim_id.as_str().to_owned(),
                })
                .collect(),
            links,
        };
        match self.store.apply_promotion(write) {
            Ok(_) => {
                if let Some(embedder) = &self.embedder {
                    let _ =
                        write_claim_vectors(&self.store, embedder.as_ref(), &commit.claims, now);
                }
                self.clear_defer(&episode.episode_id);
                Ok(PromotionAttempt::Applied {
                    claim_ids: commit
                        .claims
                        .iter()
                        .map(|claim| claim.id.as_str().to_owned())
                        .collect(),
                })
            }
            Err(_) => self.queue_retry(&episode.episode_id, now),
        }
    }

    fn next_pending(
        &self,
        now: i64,
    ) -> Result<Option<maia_store::PendingPromotionRow>, StoreError> {
        let pending = self.store.pending_promotions()?;
        let deferred = lock_mutex(&self.deferred);
        Ok(pending
            .into_iter()
            .find(|row| deferred.get(&row.episode_id).copied().unwrap_or(0) <= now))
    }

    fn account(&self, day_key: &str, calls: u32, tokens: u64) -> Result<(), StoreError> {
        let calls = i64::from(calls.max(1));
        let tokens = i64::try_from(tokens).unwrap_or(i64::MAX);
        self.store
            .bump_promotion_day_stats(day_key, calls, tokens)?;
        Ok(())
    }

    fn queue_retry(&self, episode_id: &str, now: i64) -> Result<PromotionAttempt, StoreError> {
        let note = self
            .store
            .note_promotion_failure(episode_id, i64::from(self.caps.failure_limit))?;
        let mut deferred = lock_mutex(&self.deferred);
        if note.value.quarantined {
            deferred.remove(episode_id);
        } else {
            let failures = u32::try_from(note.value.failures).unwrap_or(u32::MAX);
            let delay = promotion_backoff_seconds(failures);
            deferred.insert(episode_id.to_owned(), now.saturating_add(delay));
        }
        Ok(PromotionAttempt::QueuedRetry)
    }

    fn clear_defer(&self, episode_id: &str) {
        lock_mutex(&self.deferred).remove(episode_id);
    }
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn call_room(calls: i64, cap: u32) -> u32 {
    let left = i64::from(cap).saturating_sub(calls);
    u32::try_from(left)
        .unwrap_or(u32::MAX)
        .min(PROMOTER_FAST_ATTEMPTS)
}

fn promotion_links(
    store: &SqliteOwner,
    claims: &[PromotionClaimWrite],
    nearest: &[NearestClaimRow],
    embedder: Option<&dyn ClaimEmbedder>,
) -> Result<Vec<PromotionLinkWrite>, StoreError> {
    let ids = nearest
        .iter()
        .map(|row| row.claim_id.clone())
        .collect::<Vec<_>>();
    let taints = store.claim_taints(ids)?;
    let entity_rows = store.entity_slugs()?;
    let entities = entity_rows
        .iter()
        .map(|row| EntitySlug {
            entity_id: row.entity_id.clone(),
            slug: row.slug.clone(),
        })
        .collect::<Vec<_>>();
    let query_model = embedder.map(|embedder| embedder.identity().model_id);
    let mut links = Vec::new();
    for claim in claims {
        let mut candidates = Vec::new();
        for row in nearest {
            if row.claim_id == claim.claim_id {
                continue;
            }
            let untrusted = taints
                .iter()
                .find(|item| item.claim_id == row.claim_id)
                .is_none_or(|item| item.taint != MemoryTaint::Trusted);
            let (cosine_millis, model_id) =
                same_model_cosine(store, embedder, &claim.sentence, &row.claim_id);
            candidates.push(RelatedCandidate {
                claim_id: row.claim_id.clone(),
                lexemes: lexemes_for_sentence(&row.sentence, &DEFAULT_LEXICAL())
                    .into_iter()
                    .map(|lexeme| lexeme.as_str().to_owned())
                    .collect(),
                untrusted,
                cosine_millis,
                model_id,
            });
        }
        let new_untrusted = claim.taint != MemoryTaint::Trusted;
        for link in select_related_claims(
            &claim.lexemes,
            new_untrusted,
            query_model.as_deref(),
            &candidates,
            RELATEDNESS_FANOUT,
        ) {
            links.push(PromotionLinkWrite {
                edge_kind: "relatedness".to_owned(),
                from_claim_id: claim.claim_id.clone(),
                to_kind: "claim".to_owned(),
                to_id: link.claim_id,
                weight_millis: link.weight_millis,
            });
        }
        for link in
            select_entity_links(&claim.lexemes, &entities, new_untrusted, RELATEDNESS_FANOUT)
        {
            links.push(PromotionLinkWrite {
                edge_kind: "entity".to_owned(),
                from_claim_id: claim.claim_id.clone(),
                to_kind: "entity".to_owned(),
                to_id: link.entity_id,
                weight_millis: link.weight_millis,
            });
        }
    }
    Ok(links)
}

fn same_model_cosine(
    store: &SqliteOwner,
    embedder: Option<&dyn ClaimEmbedder>,
    sentence: &str,
    claim_id: &str,
) -> (Option<i32>, Option<String>) {
    let Some(embedder) = embedder else {
        return (None, None);
    };
    let model_id = embedder.identity().model_id;
    let Ok(vectors) = embedder.embed(&[sentence]) else {
        return (None, None);
    };
    let Some(query) = vectors.into_iter().next() else {
        return (None, None);
    };
    let Ok(Some(stored)) = store.embedding_for_model(EmbeddingTarget::Claim, claim_id, &model_id)
    else {
        return (None, None);
    };
    let query_values: Vec<f64> = query.iter().map(|value| f64::from(*value)).collect();
    let stored_values: Vec<f64> = stored.iter().map(|value| f64::from(*value)).collect();
    let Some(cosine) = cosine_of(&query_values, &stored_values) else {
        return (None, None);
    };
    let Some(millis) = cosine_millis(cosine) else {
        return (None, None);
    };
    (Some(millis), Some(model_id))
}

fn cosine_millis(cosine: f64) -> Option<i32> {
    if !(0.0..=1.0).contains(&cosine) {
        return None;
    }
    let scaled = (cosine * 1000.0).round();
    if !(0.0..=1000.0).contains(&scaled) {
        return None;
    }
    i32::try_from(scaled as i64).ok()
}

fn reconcile_claims(decision: &mut maia_core::dream::PromotionDecision, nearest: &[NearestClaimRow]) {
    use maia_core::dream::ClaimJudgment;
    use maia_core::dream::ReplaceDraft;
    use maia_core::dream::judge_claim;
    use maia_core::dream::near_duplicate;
    use maia_core::dream::supersedes;
    decision
        .new
        .retain(|sentence| judge_claim(sentence) == ClaimJudgment::Keep);
    decision
        .replaces
        .retain(|item| judge_claim(&item.sentence) == ClaimJudgment::Keep);
    let mut fresh = Vec::new();
    for sentence in std::mem::take(&mut decision.new) {
        if let Some(existing) = nearest
            .iter()
            .find(|claim| near_duplicate(&sentence, &claim.sentence))
        {
            let id = ClaimId::new(existing.claim_id.clone());
            if !decision.same.iter().any(|item| item == &id) {
                decision.same.push(id);
            }
            continue;
        }
        if let Some(existing) = nearest
            .iter()
            .find(|claim| supersedes(&claim.sentence, &sentence))
        {
            let id = ClaimId::new(existing.claim_id.clone());
            if !decision.replaces.iter().any(|item| item.old == id) {
                decision.replaces.push(ReplaceDraft { old: id, sentence });
            }
            continue;
        }
        fresh.push(sentence);
    }
    decision.new = fresh;
}

fn nearest_for_episode(
    store: &SqliteOwner,
    body: &str,
    embedder: Option<&dyn ClaimEmbedder>,
) -> Vec<NearestClaimRow> {
    let fts = fts_query(body);
    let fts_rows = if fts.is_empty() {
        Vec::new()
    } else {
        store
            .nearest_claims(&fts, NEAREST_CLAIM_LIMIT)
            .unwrap_or_default()
    };
    let fts_seeds = seeds_from_rows(&fts_rows);
    let (vector_seeds, _) = vector_seeds(store, body, embedder);
    merge_claim_seeds(&fts_seeds, &vector_seeds, NEAREST_CLAIM_LIMIT as usize)
        .into_iter()
        .map(|seed| NearestClaimRow {
            claim_id: seed.claim_id,
            sentence: seed.sentence,
        })
        .collect()
}

fn seeds_from_rows(rows: &[NearestClaimRow]) -> Vec<ClaimSeed> {
    rows.iter()
        .map(|row| ClaimSeed {
            claim_id: row.claim_id.clone(),
            sentence: row.sentence.clone(),
            distance_bits: None,
        })
        .collect()
}

fn vector_seeds(
    store: &SqliteOwner,
    text: &str,
    embedder: Option<&dyn ClaimEmbedder>,
) -> (Vec<ClaimSeed>, Option<QueryEmbedding>) {
    let Some(embedder) = embedder else {
        return (Vec::new(), None);
    };
    let Ok(vectors) = embedder.embed(&[text]) else {
        return (Vec::new(), None);
    };
    let Some(values) = vectors.into_iter().next() else {
        return (Vec::new(), None);
    };
    let identity = embedder.identity();
    let hits = store
        .nearest_claim_vectors(&identity.model_id, &values, NEAREST_CLAIM_LIMIT)
        .unwrap_or_default();
    let seeds = hits
        .into_iter()
        .map(|hit| ClaimSeed {
            claim_id: hit.claim_id,
            sentence: hit.sentence,
            distance_bits: Some(hit.distance_bits),
        })
        .collect();
    let embedding = QueryEmbedding {
        values: values.iter().map(|value| f64::from(*value)).collect(),
        model: EmbedderModel::new(identity.model_id),
    };
    (seeds, Some(embedding))
}

fn write_claim_vectors(
    store: &SqliteOwner,
    embedder: &dyn ClaimEmbedder,
    claims: &[maia_core::dream::CommittedClaim],
    now: i64,
) -> Result<(), EmbedFailure> {
    if claims.is_empty() {
        return Ok(());
    }
    let identity = embedder.identity();
    if !model_compatible(store, &identity, now)? {
        return Err(EmbedFailure::Unavailable);
    }
    let texts: Vec<&str> = claims.iter().map(|claim| claim.sentence.as_str()).collect();
    let vectors = embedder.embed(&texts)?;
    if vectors.len() != claims.len() {
        return Err(EmbedFailure::Unavailable);
    }
    for (claim, values) in claims.iter().zip(vectors) {
        if u64::try_from(values.len()).ok() != Some(identity.dimensions) {
            continue;
        }
        let _ = store.upsert_embedding(EmbeddingWrite {
            target: EmbeddingTarget::Claim,
            target_id: claim.id.as_str().to_owned(),
            model_id: identity.model_id.clone(),
            values,
        });
    }
    Ok(())
}

fn model_compatible(
    store: &SqliteOwner,
    identity: &ClaimEmbedderIdentity,
    now: i64,
) -> Result<bool, EmbedFailure> {
    let models = store
        .embedding_models()
        .map_err(|_| EmbedFailure::Unavailable)?;
    if let Some(stored) = models
        .iter()
        .find(|model| model.model_id == identity.model_id)
    {
        return Ok(stored.dimensions == identity.dimensions
            && stored.weights_sha256 == identity.weights_sha256
            && stored.tokenizer_sha256 == identity.tokenizer_sha256);
    }
    store
        .put_embedding_model(EmbeddingModelWrite {
            model_id: identity.model_id.clone(),
            dimensions: identity.dimensions,
            weights_sha256: identity.weights_sha256.clone(),
            tokenizer_sha256: identity.tokenizer_sha256.clone(),
            query_prefix: identity.query_prefix.clone(),
            document_prefix: identity.document_prefix.clone(),
            recorded_at: now,
        })
        .map_err(|_| EmbedFailure::Unavailable)?;
    Ok(true)
}

fn fts_query(body: &str) -> String {
    let lexical = DEFAULT_LEXICAL();
    let mut terms = BTreeSet::new();
    for lexeme in lexemes_for_sentence(body, &lexical) {
        let token = lexeme.as_str();
        if token.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            terms.insert(token.to_owned());
        }
    }
    terms.into_iter().take(8).collect::<Vec<_>>().join(" OR ")
}

fn build_promoter_prompt(body: &str, nearest: &[NearestClaimRow]) -> String {
    let mut prompt = String::new();
    prompt.push_str("Episode:\n");
    prompt.push_str(body);
    prompt.push_str("\n\nNearest existing claims:\n");
    if nearest.is_empty() {
        prompt.push_str("(none)\n");
    } else {
        for claim in nearest {
            prompt.push_str("- ");
            prompt.push_str(&claim.claim_id);
            prompt.push_str(": ");
            prompt.push_str(&claim.sentence);
            prompt.push('\n');
        }
    }
    prompt
}

fn known_claim_ids(store: &SqliteOwner) -> Result<BTreeSet<ClaimId>, StoreError> {
    let map = store.brain_map()?;
    Ok(map
        .nodes
        .into_iter()
        .filter(|node| node.kind == maia_store::BrainNodeKind::Claim)
        .map(|node| ClaimId::new(node.id))
        .collect())
}

fn store_taint(taint: MemoryTaint) -> Taint {
    match taint {
        MemoryTaint::Trusted => Taint::Trusted,
        MemoryTaint::Untrusted => Taint::Untrusted,
    }
}

fn episode_memory_taint(episode: &maia_store::PromotionEpisodeRow) -> MemoryTaint {
    if episode.taint == MemoryTaint::Untrusted
        || episode
            .segments
            .iter()
            .any(|segment| segment.taint == MemoryTaint::Untrusted)
    {
        MemoryTaint::Untrusted
    } else {
        MemoryTaint::Trusted
    }
}

fn day_key(now: i64) -> String {
    let days = now.div_euclid(86_400);
    format!("day-{days}")
}

fn usage_total(usage: &RouterUsage) -> u64 {
    reported(usage.input_tokens).saturating_add(reported(usage.output_tokens))
}

fn reported(value: UsageValue) -> u64 {
    match value {
        UsageValue::Reported(n) | UsageValue::Estimated(n) => n,
        UsageValue::Unavailable => 0,
    }
}

fn response_text(response: &RouterResponse) -> String {
    if let Some(reply) = &response.reply
        && !reply.trim().is_empty()
    {
        return reply.clone();
    }
    response.reasoning.clone().unwrap_or_default()
}

fn redact_router_error(error: &RouterError) -> String {
    classify_router_failure(error).redacted_log()
}

enum Timed<T> {
    Ready(T),
    Expired,
}

fn block_on_timeout<T>(
    timeout: Duration,
    future: impl std::future::Future<Output = T>,
) -> Result<Timed<T>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "promoter runtime".to_owned())?;
    Ok(runtime.block_on(async move {
        match tokio::time::timeout(timeout, future).await {
            Ok(value) => Timed::Ready(value),
            Err(_) => Timed::Expired,
        }
    }))
}

/// Keyword, vector, and graph hit counts for one recall.
#[derive(Debug, Clone, PartialEq)]
pub struct RecallArms {
    /// Notes the keyword arm returned.
    pub keyword: i64,
    /// Notes the vector arm returned.
    pub vector: i64,
    /// Notes the graph arm returned.
    pub graph: i64,
    /// Ranked lines after fusion and the existing ranker. Empty when nothing packed.
    pub packed: Option<crate::inspector::PackedRecall>,
    /// Ranked hits with the arms that matched, for the Brain search box.
    pub hits: Vec<RecallHit>,
}

/// One fused recall hit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecallHit {
    /// Stable id.
    pub id: String,
    /// `claim`, `fact`, or `episode`.
    pub kind: String,
    /// Sentence or title.
    pub sentence: String,
    /// Which arms matched: keyword, vector, graph.
    pub arms: Vec<String>,
}

/// Builds recall seeds from keyword, vector, and graph arms, then ranks two hops.
pub fn bounded_recall(
    store: &SqliteOwner,
    query: &str,
    now: Timestamp,
    embedder: Option<&dyn ClaimEmbedder>,
) -> Option<crate::inspector::PackedRecall> {
    recall_run(store, query, now, embedder).packed
}

/// Same path as [`bounded_recall`], including the arm counts recorded for the Brain tab.
pub fn recall_run(
    store: &SqliteOwner,
    query: &str,
    now: Timestamp,
    embedder: Option<&dyn ClaimEmbedder>,
) -> RecallArms {
    let lexical = DEFAULT_LEXICAL();
    let lexeme_ids: Vec<String> = lexemes_for_sentence(query, &lexical)
        .iter()
        .map(|lexeme| lexeme.as_str().to_owned())
        .collect();
    let keyword_hits = store
        .search_neurons(query, NEAREST_CLAIM_LIMIT)
        .unwrap_or_default();
    let (vector_seeds, query_embedding) = vector_seeds(store, query, embedder);
    let graph_hits = store
        .graph_arm(&lexeme_ids, NEAREST_CLAIM_LIMIT)
        .unwrap_or_default();
    let keyword_arm = keyword_hits
        .iter()
        .map(|hit| format!("{}:{}", hit.kind, hit.id))
        .collect::<Vec<_>>();
    let vector_arm = vector_seeds
        .iter()
        .map(|seed| format!("claim:{}", seed.claim_id.as_str()))
        .collect::<Vec<_>>();
    let graph_arm_ids = graph_hits
        .iter()
        .map(|hit| format!("{}:{}", hit.kind, hit.id))
        .collect::<Vec<_>>();
    let keyword_ids = keyword_arm.clone();
    let vector_ids = vector_arm.clone();
    let graph_ids = graph_arm_ids.clone();
    let fused = reciprocal_rank_fusion(&[keyword_arm, vector_arm, graph_arm_ids], RRF_K)
        .unwrap_or_default();
    let mut claim_ids = Vec::new();
    let mut fact_ids = Vec::new();
    for rank in fused.iter().take(NEAREST_CLAIM_LIMIT as usize) {
        let Some((kind, id)) = rank.id.split_once(':') else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        if kind == "claim" {
            claim_ids.push(id.to_owned());
        } else if kind == "fact" {
            fact_ids.push(id.to_owned());
        }
    }
    let keyword_count = i64::try_from(keyword_hits.len()).unwrap_or(0);
    let vector_count = i64::try_from(vector_seeds.len()).unwrap_or(0);
    let graph_count = i64::try_from(graph_hits.len()).unwrap_or(0);
    let _ = store.record_recall_arms(keyword_count, vector_count, graph_count);
    let mut titles = std::collections::BTreeMap::new();
    for hit in keyword_hits.iter().chain(graph_hits.iter()) {
        titles.insert(format!("{}:{}", hit.kind, hit.id), hit.title.clone());
    }
    let hits = fused
        .iter()
        .take(NEAREST_CLAIM_LIMIT as usize)
        .filter_map(|rank| {
            let (kind, id) = rank.id.split_once(':')?;
            if id.is_empty() {
                return None;
            }
            let mut arms = Vec::new();
            if keyword_ids.iter().any(|item| item == &rank.id) {
                arms.push("keyword".to_owned());
            }
            if vector_ids.iter().any(|item| item == &rank.id) {
                arms.push("vector".to_owned());
            }
            if graph_ids.iter().any(|item| item == &rank.id) {
                arms.push("graph".to_owned());
            }
            Some(RecallHit {
                id: id.to_owned(),
                kind: kind.to_owned(),
                sentence: titles.get(&rank.id).cloned().unwrap_or_default(),
                arms,
            })
        })
        .collect::<Vec<_>>();
    let Some(map) = store
        .recall_subgraph_seeded(&claim_ids, &fact_ids, &lexeme_ids, 2)
        .ok()
    else {
        return RecallArms {
            keyword: keyword_count,
            vector: vector_count,
            graph: graph_count,
            packed: None,
            hits,
        };
    };
    if map.nodes.is_empty() {
        return RecallArms {
            keyword: keyword_count,
            vector: vector_count,
            graph: graph_count,
            packed: None,
            hits,
        };
    }
    let (mut graph, quarantine) = crate::inspector::recall_graph(&map);
    link_keyword_overlap(&mut graph, query, &claim_ids, &fact_ids);
    if let Some(embedding) = &query_embedding {
        attach_model_vectors(store, &mut graph, embedding);
    }
    let embedding = query_embedding.as_ref();
    let packed = if embedding.is_none() {
        crate::inspector::pack_recall(&graph, query, now, &quarantine)
    } else {
        crate::inspector::pack_recall_with_embedding(&graph, query, now, &quarantine, embedding)
    };
    RecallArms {
        keyword: keyword_count,
        vector: vector_count,
        graph: graph_count,
        packed: packed.ok().flatten(),
        hits,
    }
}

fn link_keyword_overlap(
    graph: &mut RecallGraph,
    query: &str,
    claim_ids: &[String],
    fact_ids: &[String],
) {
    let lexical = DEFAULT_LEXICAL();
    let query_lexemes = lexemes_for_sentence(query, &lexical);
    for lexeme in &query_lexemes {
        graph.lexemes.insert(lexeme.clone());
    }
    for id in claim_ids {
        let claim_id = ClaimId::new(id.clone());
        let Some(sentence) = graph
            .claims
            .get(&claim_id)
            .map(|claim| claim.sentence.clone())
        else {
            continue;
        };
        connect_overlap(
            graph,
            &query_lexemes,
            &sentence,
            maia_core::brain::NodeId::Claim(claim_id),
        );
    }
    for id in fact_ids {
        let fact_id = maia_core::brain::FactId::new(id.clone());
        let Some(sentence) = graph.facts.get(&fact_id).map(|fact| fact.sentence.clone()) else {
            continue;
        };
        connect_overlap(
            graph,
            &query_lexemes,
            &sentence,
            maia_core::brain::NodeId::Fact(fact_id),
        );
    }
}

fn connect_overlap(
    graph: &mut RecallGraph,
    query_lexemes: &[maia_core::brain::LexemeId],
    sentence: &str,
    target: maia_core::brain::NodeId,
) {
    let sentence_lexemes = lexemes_for_sentence(sentence, &DEFAULT_LEXICAL());
    for lexeme in query_lexemes {
        if !sentence_lexemes
            .iter()
            .any(|item| same_keyword_term(item.as_str(), lexeme.as_str()))
        {
            continue;
        }
        let from = maia_core::brain::NodeId::Lexeme(lexeme.clone());
        if graph
            .edges
            .iter()
            .any(|edge| edge.from == from && edge.to == target)
        {
            continue;
        }
        graph.edges.push(maia_core::brain::GraphEdge {
            from,
            to: target.clone(),
            weight: 1.0,
        });
    }
}

fn attach_model_vectors(store: &SqliteOwner, graph: &mut RecallGraph, query: &QueryEmbedding) {
    for (id, claim) in graph.claims.iter_mut() {
        let Ok(Some(values)) =
            store.embedding_for_model(EmbeddingTarget::Claim, id.as_str(), query.model.as_str())
        else {
            continue;
        };
        let stored: Vec<f64> = values.iter().map(|value| f64::from(*value)).collect();
        // A negative cosine would subtract from a lexical hit. Leave the vector
        // unloaded so full-text and lexemes still rank, matching a missing embedding.
        if cosine_of(&query.values, &stored).is_some_and(|score| score < 0.0) {
            continue;
        }
        claim.embedding = Some(StoredEmbedding {
            values: stored,
            model: EmbedderModel::new(query.model.as_str()),
        });
    }
}

fn cosine_of(query: &[f64], stored: &[f64]) -> Option<f64> {
    if query.len() != stored.len() || query.is_empty() {
        return None;
    }
    let mut dot = 0.0;
    let mut left = 0.0;
    let mut right = 0.0;
    for (left_value, right_value) in query.iter().zip(stored) {
        if !left_value.is_finite() || !right_value.is_finite() {
            return None;
        }
        dot += left_value * right_value;
        left += left_value * left_value;
        right += right_value * right_value;
    }
    if left == 0.0 || right == 0.0 {
        return None;
    }
    Some(dot / (left.sqrt() * right.sqrt()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maia_core::router::FinishReason;
    use maia_core::router::Router;
    use std::sync::atomic::AtomicU32;

    #[test]
    fn fts_query_strips_to_alphanumeric_lexemes() {
        let query = fts_query("The project is named Bob's Best Burgers.");
        assert!(query.contains("bob") || query.contains("burgers") || query.contains("project"));
        assert!(!query.contains('\''));
    }

    #[test]
    fn promoter_errors_do_not_include_secret_text() {
        let note = redact_router_error(&RouterError::Protocol {
            detail: "Authorization Bearer sk-live-secret-value".to_owned(),
        });
        let lowered = note.to_ascii_lowercase();
        assert!(!lowered.contains("sk-live"));
        assert!(!lowered.contains("bearer"));
        assert!(!lowered.contains("authorization"));
    }

    struct HangRouter;

    impl Router for HangRouter {
        async fn complete(&self, _request: &RouterRequest) -> Result<RouterResponse, RouterError> {
            std::future::pending().await
        }

        async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
            Ok(())
        }
    }

    #[test]
    fn promoter_timeout_is_not_retried() {
        let mut promoter = RouterPromoter::new(HangRouter, "auto");
        let started = std::time::Instant::now();
        let turn = promoter.complete(
            "hello",
            CallLimits {
                timeout: Duration::from_millis(40),
                attempts: 3,
                backoff: Duration::from_millis(1),
            },
        );
        assert_eq!(turn.calls, 1);
        assert!(started.elapsed() < Duration::from_millis(500));
        let Err(note) = turn.body else {
            panic!("expected a promoter timeout");
        };
        assert!(!note.contains("sk-"));
    }

    struct FailTwice {
        hits: AtomicU32,
    }

    impl Router for FailTwice {
        async fn complete(&self, request: &RouterRequest) -> Result<RouterResponse, RouterError> {
            let hit = self.hits.fetch_add(1, Ordering::Relaxed);
            if hit < 2 {
                return Err(RouterError::RateLimited);
            }
            Ok(RouterResponse {
                request_id: request.request_id.clone(),
                provider_response_id: None,
                reasoning: None,
                tool_calls: Vec::new(),
                reply: Some(r#"{"skip":true,"new":[],"same":[],"replaces":[]}"#.to_owned()),
                usage: RouterUsage {
                    input_tokens: UsageValue::Reported(1),
                    output_tokens: UsageValue::Reported(1),
                    cached_input_tokens: UsageValue::Unavailable,
                },
                finish: FinishReason::Stop,
            })
        }

        async fn cancel(&self, _request_id: RequestId) -> Result<(), RouterError> {
            Ok(())
        }
    }

    #[test]
    fn promoter_retries_a_fast_failure_with_backoff_then_stops() {
        let mut promoter = RouterPromoter::new(
            FailTwice {
                hits: AtomicU32::new(0),
            },
            "auto",
        );
        let turn = promoter.complete(
            "hello",
            CallLimits {
                timeout: Duration::from_millis(200),
                attempts: 3,
                backoff: Duration::from_millis(1),
            },
        );
        assert!(turn.body.is_ok());
        assert_eq!(turn.calls, 3);
    }
}
