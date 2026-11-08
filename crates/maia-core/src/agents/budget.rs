//! Lease budget admission.

use crate::agents::types::{
    BudgetExceeded, BudgetKind, BudgetUsage, Reservation, RunBudget, SpendBreakerState, StepKind,
    StepRequest,
};

/// Reserves budget for one external step; fails closed on breaker or ceiling.
pub fn admit_step(
    usage: &BudgetUsage,
    request: &StepRequest,
    limits: &RunBudget,
    breaker: &SpendBreakerState,
) -> Result<Reservation, BudgetExceeded> {
    if breaker.tripped {
        return Err(BudgetExceeded::BreakerTripped);
    }
    match request.kind {
        StepKind::Router { reserve_tokens } => {
            let total = usage
                .router_tokens
                .saturating_add(usage.reserved_router_tokens)
                .saturating_add(reserve_tokens);
            if total > limits.max_router_tokens {
                return Err(BudgetExceeded::CeilingReached {
                    kind: BudgetKind::RouterTokens,
                });
            }
            Ok(Reservation {
                router_tokens: reserve_tokens,
                tool_turns: 0,
            })
        }
        StepKind::Tool => {
            let total = usage
                .tool_turns
                .saturating_add(usage.reserved_tool_turns)
                .saturating_add(1);
            if total > limits.max_tool_turns {
                return Err(BudgetExceeded::CeilingReached {
                    kind: BudgetKind::ToolTurns,
                });
            }
            Ok(Reservation {
                router_tokens: 0,
                tool_turns: 1,
            })
        }
    }
}
