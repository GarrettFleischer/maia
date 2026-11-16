//! Durable wake schedule for the autonomous manager.
//!
//! Sidecar JSON beside the database (same pattern as live_reply). Does not
//! open SQLite directly.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use maia_core::manager::DEFAULT_AUTONOMOUS_RETRY_BUDGET;
use maia_core::manager::DEFAULT_WAKE_INTERVAL_SECS;
use serde_json::Value;
use serde_json::json;

/// Persisted wake settings and last observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagerWakeState {
    /// Seconds between wake checks.
    pub interval_secs: u64,
    /// Unix seconds of the last wake that ran.
    pub last_wake_at: u64,
    /// Fingerprint of the last observed snapshot.
    pub last_fingerprint: String,
    /// Model calls used on the calendar day `cost_day`.
    pub model_calls_today: u32,
    /// Calendar day key `YYYY-MM-DD` for the cost counter.
    pub cost_day: String,
    /// Automatic recoveries per goal before the host forces ask_user.
    pub restart_budget: u32,
    /// When true, drop non-essential wake status chatter (keep ask + close-out).
    pub mute_nonessential_wake_messages: bool,
    /// Short notes the manager recorded.
    pub learned: Vec<String>,
}

impl Default for ManagerWakeState {
    fn default() -> Self {
        Self {
            interval_secs: DEFAULT_WAKE_INTERVAL_SECS,
            last_wake_at: 0,
            last_fingerprint: String::new(),
            model_calls_today: 0,
            cost_day: String::new(),
            restart_budget: DEFAULT_AUTONOMOUS_RETRY_BUDGET,
            mute_nonessential_wake_messages: false,
            learned: Vec::new(),
        }
    }
}

/// Path of the wake sidecar next to the SQLite file.
#[must_use]
pub fn wake_path_beside(database: &Path) -> PathBuf {
    database
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("manager_wake.json")
}

/// Loads wake state. Missing or corrupt files become defaults.
#[must_use]
pub fn load_wake_state(path: &Path) -> ManagerWakeState {
    let Ok(text) = fs::read_to_string(path) else {
        return ManagerWakeState::default();
    };
    parse_wake_state(&text)
}

/// Writes wake state as JSON.
pub fn save_wake_state(path: &Path, state: &ManagerWakeState) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, wake_state_json(state))
}

/// Parses wake JSON into state.
#[must_use]
pub fn parse_wake_state(text: &str) -> ManagerWakeState {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return ManagerWakeState::default();
    };
    ManagerWakeState {
        interval_secs: value
            .get("interval_secs")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_WAKE_INTERVAL_SECS)
            .max(30),
        last_wake_at: value
            .get("last_wake_at")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        last_fingerprint: value
            .get("last_fingerprint")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        model_calls_today: value
            .get("model_calls_today")
            .and_then(Value::as_u64)
            .and_then(|raw| u32::try_from(raw).ok())
            .unwrap_or(0),
        cost_day: value
            .get("cost_day")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        restart_budget: value
            .get("restart_budget")
            .and_then(Value::as_u64)
            .and_then(|raw| u32::try_from(raw).ok())
            .unwrap_or(DEFAULT_AUTONOMOUS_RETRY_BUDGET)
            .clamp(1, 20),
        mute_nonessential_wake_messages: value
            .get("mute_nonessential_wake_messages")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        learned: value
            .get("learned")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.as_str().map(str::to_owned))
                    .take(32)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Serializes wake state.
#[must_use]
pub fn wake_state_json(state: &ManagerWakeState) -> String {
    json!({
        "interval_secs": state.interval_secs,
        "last_wake_at": state.last_wake_at,
        "last_fingerprint": state.last_fingerprint,
        "model_calls_today": state.model_calls_today,
        "cost_day": state.cost_day,
        "restart_budget": state.restart_budget,
        "mute_nonessential_wake_messages": state.mute_nonessential_wake_messages,
        "learned": state.learned,
    })
    .to_string()
}

/// Calendar day key from unix seconds (UTC).
#[must_use]
pub fn cost_day_key(unix_secs: u64) -> String {
    let days = unix_secs / 86_400;
    // 1970-01-01 + days — enough for a stable bucket key without chrono.
    format!("day-{days}")
}

/// Resets the daily counter when the calendar day changes.
pub fn roll_cost_day(state: &mut ManagerWakeState, now_secs: u64) {
    let today = cost_day_key(now_secs);
    if state.cost_day != today {
        state.cost_day = today;
        state.model_calls_today = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_state_round_trips() {
        let state = ManagerWakeState {
            interval_secs: 120,
            last_wake_at: 99,
            last_fingerprint: "fp".to_owned(),
            model_calls_today: 2,
            cost_day: "day-1".to_owned(),
            restart_budget: 5,
            mute_nonessential_wake_messages: true,
            learned: vec!["tried bash twice".to_owned()],
        };
        let restored = parse_wake_state(&wake_state_json(&state));
        assert_eq!(restored, state);
    }

    #[test]
    fn missing_owner_knobs_default_safely() {
        let restored = parse_wake_state(r#"{"interval_secs":300}"#);
        assert_eq!(restored.restart_budget, DEFAULT_AUTONOMOUS_RETRY_BUDGET);
        assert!(!restored.mute_nonessential_wake_messages);
    }
}
