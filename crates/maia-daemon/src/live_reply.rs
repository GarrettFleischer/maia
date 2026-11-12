//! In-memory partial reply shared by every connected browser.
//!
//! The text is not a transcript row. A finished turn stores its own message,
//! and that stored message is the answer.

use std::sync::Arc;
use std::sync::Mutex;

use maia_router::ReplyProgress;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;

/// Whether tokens are still arriving or the stream stopped early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivePhase {
    /// Tokens are still arriving.
    Streaming,
    /// The stream stopped before a stored answer replaced it.
    Interrupted,
}

/// One visible partial for a bot. It has no message id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveView {
    /// Bot whose chat is showing the partial.
    pub bot_id: String,
    /// Generation. A newer id replaces an older sentence.
    pub stream_id: u64,
    /// Increases when the visible text changes.
    pub revision: u64,
    /// Text received so far. This is not the stored answer.
    pub text: String,
    /// Streaming or stopped early.
    pub phase: LivePhase,
}

struct LiveState {
    next_stream: u64,
    active_request: Option<String>,
    active_stream: u64,
    active_bot: String,
    current: Option<LiveView>,
}

/// Shared partial for the owner-facing model call.
#[derive(Clone)]
pub struct LiveReplyBoard {
    inner: Arc<Mutex<LiveState>>,
    updates: watch::Sender<String>,
}

impl LiveReplyBoard {
    /// Empty board. Nothing is published until a watched call emits text.
    pub fn new() -> Self {
        let (updates, _) = watch::channel(String::new());
        Self {
            inner: Arc::new(Mutex::new(LiveState {
                next_stream: 0,
                active_request: None,
                active_stream: 0,
                active_bot: String::new(),
                current: None,
            })),
            updates,
        }
    }

    /// Subscribes to partial frames. Empty frames are not a reply.
    pub fn subscribe(&self) -> watch::Receiver<String> {
        self.updates.subscribe()
    }

    /// Arms the next owner-facing model call. Older request ids stop updating.
    pub fn watch(&self, bot_id: &str, request_id: &str) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.next_stream = state.next_stream.saturating_add(1);
        state.active_stream = state.next_stream;
        state.active_request = Some(request_id.to_owned());
        state.active_bot = bot_id.to_owned();
    }

    /// Drops the partial after a durable assistant message is stored.
    pub fn settle(&self, bot_id: &str) {
        let frame = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            let matches = state
                .current
                .as_ref()
                .is_some_and(|view| view.bot_id == bot_id)
                || state.active_bot == bot_id;
            if !matches {
                return;
            }
            state.current = None;
            state.active_request = None;
            cleared_frame(bot_id)
        };
        self.updates.send_replace(frame);
    }

    /// The partial for one bot, when it still has text.
    pub fn snapshot(&self, bot_id: &str) -> Option<LiveView> {
        let Ok(state) = self.inner.lock() else {
            return None;
        };
        state
            .current
            .clone()
            .filter(|view| view.bot_id == bot_id && !view.text.is_empty())
    }
}

impl Default for LiveReplyBoard {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplyProgress for LiveReplyBoard {
    fn on_visible_reply(&self, request_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let frame = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.active_request.as_deref() != Some(request_id) {
                return;
            }
            let stream_id = state.active_stream;
            let bot_id = state.active_bot.clone();
            let view = match state.current.take() {
                Some(mut view) if view.stream_id == stream_id && view.text == text => {
                    view.phase = LivePhase::Streaming;
                    view
                }
                Some(mut view) if view.stream_id == stream_id => {
                    view.text = text.to_owned();
                    view.revision = view.revision.saturating_add(1);
                    view.phase = LivePhase::Streaming;
                    view
                }
                _ => LiveView {
                    bot_id,
                    stream_id,
                    revision: 1,
                    text: text.to_owned(),
                    phase: LivePhase::Streaming,
                },
            };
            let frame = live_frame(&view);
            state.current = Some(view);
            frame
        };
        self.updates.send_replace(frame);
    }

    fn on_reply_interrupted(&self, request_id: &str) {
        let frame = {
            let Ok(mut state) = self.inner.lock() else {
                return;
            };
            if state.active_request.as_deref() != Some(request_id) {
                return;
            }
            state.active_request = None;
            let Some(view) = state.current.as_mut() else {
                return;
            };
            view.phase = LivePhase::Interrupted;
            live_frame(view)
        };
        self.updates.send_replace(frame);
    }
}

/// Adds the partial beside the stored messages without inserting a row.
pub fn attach_live_reply(transcript: &mut Value, live: Option<&LiveView>) {
    let Some(object) = transcript.as_object_mut() else {
        return;
    };
    match live {
        Some(live) if !live.text.is_empty() => {
            object.insert("live".to_owned(), live_json(live));
        }
        _ => {
            object.remove("live");
        }
    }
}

fn live_json(live: &LiveView) -> Value {
    json!({
        "bot_id": live.bot_id,
        "stream_id": live.stream_id.to_string(),
        "revision": live.revision,
        "text": live.text,
        "phase": phase_name(live.phase),
    })
}

fn live_frame(live: &LiveView) -> String {
    let mut value = live_json(live);
    if let Some(object) = value.as_object_mut() {
        object.insert("kind".to_owned(), json!("live"));
    }
    value.to_string()
}

fn cleared_frame(bot_id: &str) -> String {
    json!({
        "kind": "live",
        "cleared": true,
        "bot_id": bot_id,
    })
    .to_string()
}

fn phase_name(phase: LivePhase) -> &'static str {
    match phase {
        LivePhase::Streaming => "streaming",
        LivePhase::Interrupted => "interrupted",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_update_one_stream_and_a_stale_request_cannot_extend_it() {
        let board = LiveReplyBoard::new();
        board.watch("maia", "11");
        board.on_visible_reply("11", "Hel");
        board.on_visible_reply("11", "Hello");
        let view = board.snapshot("maia").expect("partial");
        assert_eq!(view.text, "Hello");
        assert_eq!(view.revision, 2);
        assert_eq!(view.phase, LivePhase::Streaming);
        assert!(view.stream_id > 0);

        board.on_visible_reply("10", "stale");
        assert_eq!(board.snapshot("maia").expect("partial").text, "Hello");
    }

    #[test]
    fn an_interrupted_partial_is_kept_and_is_not_a_transcript_row() {
        let board = LiveReplyBoard::new();
        board.watch("maia", "11");
        board.on_visible_reply("11", "The pin is");
        board.on_reply_interrupted("11");
        board.on_visible_reply("11", "The pin is ready");
        let view = board.snapshot("maia").expect("partial");
        assert_eq!(view.text, "The pin is");
        assert_eq!(view.phase, LivePhase::Interrupted);

        let mut transcript = json!({
            "messages": [{"message_id": "m1", "role": "owner", "text": "hi"}]
        });
        let before = transcript["messages"].as_array().expect("rows").len();
        attach_live_reply(&mut transcript, Some(&view));
        assert_eq!(
            transcript["messages"].as_array().expect("rows").len(),
            before
        );
        assert!(transcript["live"].get("message_id").is_none());
        assert_eq!(transcript["live"]["phase"], "interrupted");
        assert_eq!(transcript["live"]["text"], "The pin is");
    }

    #[test]
    fn a_new_stream_replaces_the_old_sentence_and_settle_clears_it() {
        let board = LiveReplyBoard::new();
        board.watch("maia", "11");
        board.on_visible_reply("11", "Old");
        board.watch("maia", "12");
        board.on_visible_reply("11", "Old again");
        assert_eq!(board.snapshot("maia").expect("old").text, "Old");
        board.on_visible_reply("12", "New");
        let view = board.snapshot("maia").expect("new");
        assert_eq!(view.text, "New");
        assert_eq!(view.revision, 1);

        board.settle("maia");
        assert!(board.snapshot("maia").is_none());
        let mut transcript = json!({"messages": []});
        attach_live_reply(&mut transcript, board.snapshot("maia").as_ref());
        assert!(transcript.get("live").is_none());
    }

    #[test]
    fn another_bot_does_not_see_the_partial() {
        let board = LiveReplyBoard::new();
        board.watch("maia", "11");
        board.on_visible_reply("11", "Hello");
        assert!(board.snapshot("other").is_none());
    }
}
