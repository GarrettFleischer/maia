//! Co-use edge increments from accepted presentations.

use crate::credit::types::{Acceptance, EdgeIncrement, Presentation};

/// Returns pairwise `min(weight_a, weight_b)` increments for accepted positive uses.
#[must_use]
pub fn co_use_updates(presentations: &[Presentation]) -> Vec<EdgeIncrement> {
    let mut used = Vec::new();
    for presentation in presentations {
        if presentation.acceptance != Acceptance::Accepted || presentation.weight <= 0.0 {
            continue;
        }
        used.push(presentation);
    }
    let mut increments = Vec::new();
    for left_index in 0..used.len() {
        for right_index in (left_index + 1)..used.len() {
            let left = used[left_index];
            let right = used[right_index];
            if left.memory == right.memory {
                continue;
            }
            let (first, second) = if left.memory <= right.memory {
                (left.memory.clone(), right.memory.clone())
            } else {
                (right.memory.clone(), left.memory.clone())
            };
            increments.push(EdgeIncrement {
                left: first,
                right: second,
                weight: left.weight.min(right.weight),
            });
        }
    }
    increments.sort_by(|left, right| {
        left.left
            .cmp(&right.left)
            .then_with(|| left.right.cmp(&right.right))
    });
    increments
}
