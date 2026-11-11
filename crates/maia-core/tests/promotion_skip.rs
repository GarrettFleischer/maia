//! Code-side skip rule for empty, tool-noise, and small-talk episodes.

use maia_core::dream::{PromotionSkipReason, should_skip_promotion};

#[test]
fn skips_empty_tool_noise_and_small_talk() {
    assert_eq!(
        should_skip_promotion("   "),
        Some(PromotionSkipReason::Empty)
    );
    assert_eq!(
        should_skip_promotion("tool: shell\n{\"name\":\"ls\"}"),
        Some(PromotionSkipReason::ToolNoise)
    );
    assert_eq!(
        should_skip_promotion("thanks"),
        Some(PromotionSkipReason::SmallTalk)
    );
    assert_eq!(
        should_skip_promotion("The project is named Bob's Best Burgers."),
        None
    );
    assert_eq!(
        should_skip_promotion("Owner: hello\nMaia: hi"),
        Some(PromotionSkipReason::SmallTalk)
    );
    assert_eq!(
        should_skip_promotion("Owner: hello, the project is named Bob's Best Burgers."),
        None
    );
}
