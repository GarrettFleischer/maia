//! Weighted ACT-R base activation.

use crate::audit::Timestamp;

/// Unit used to convert presentation timestamps into positive ages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgeUnit {
    /// Elapsed whole seconds between `now` and the presentation time.
    Seconds,
}

/// One traced presentation contributing to base activation.
#[derive(Debug, Clone, PartialEq)]
pub struct WeightedPresentation {
    /// Recorded presentation weight (`1.0`, `0.5`, or `0.0`).
    pub weight: f64,
    /// Instant the presentation was recorded.
    pub presented_at: Timestamp,
}

/// Typed activation failures. Never produces NaN or infinities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationError {
    /// No presentations were supplied, so `ln(0)` is undefined.
    NoPresentations,
    /// Decay was NaN or infinite.
    NonFiniteDecay,
    /// Decay was zero or negative.
    NonPositiveDecay,
    /// A presentation weight was NaN or infinite.
    NonFiniteWeight,
    /// A presentation weight was negative.
    NegativeWeight,
    /// A presentation was dated at or after `now`, so its age is not positive.
    NonPositiveAge,
    /// All finite contributions summed to zero, so `ln(0)` is undefined.
    NonPositiveMass,
}

/// Computes `ln(Σ w_j * t_j^(-d))` from explicit presentations, time, and decay.
pub fn activation(
    presentations: &[WeightedPresentation],
    now: Timestamp,
    decay: f64,
    age_unit: AgeUnit,
) -> Result<f64, ActivationError> {
    if presentations.is_empty() {
        return Err(ActivationError::NoPresentations);
    }
    if !decay.is_finite() {
        return Err(ActivationError::NonFiniteDecay);
    }
    if decay <= 0.0 {
        return Err(ActivationError::NonPositiveDecay);
    }

    let mut mass = 0.0;
    for presentation in presentations {
        if !presentation.weight.is_finite() {
            return Err(ActivationError::NonFiniteWeight);
        }
        if presentation.weight < 0.0 {
            return Err(ActivationError::NegativeWeight);
        }
        let age = positive_age(now, presentation.presented_at, age_unit)?;
        mass += presentation.weight * age.powf(-decay);
    }
    if mass <= 0.0 || !mass.is_finite() {
        return Err(ActivationError::NonPositiveMass);
    }
    Ok(mass.ln())
}

fn positive_age(
    now: Timestamp,
    presented_at: Timestamp,
    age_unit: AgeUnit,
) -> Result<f64, ActivationError> {
    match age_unit {
        AgeUnit::Seconds => {
            let Some(delta) = now.0.checked_sub(presented_at.0) else {
                return Err(ActivationError::NonPositiveAge);
            };
            if delta <= 0 {
                return Err(ActivationError::NonPositiveAge);
            }
            Ok(delta as f64)
        }
    }
}
