//! Weighted ACT-R activation contracts from `docs/design/02-brain.md`.
//!
//! Expected values are closed-form `ln(Σ w_j * t_j^(-d))` with `AgeUnit::Seconds`.

use maia_core::audit::Timestamp;
use maia_core::credit::{ActivationError, AgeUnit, WeightedPresentation, activation};

fn presented(weight: f64, seconds: i64) -> WeightedPresentation {
    WeightedPresentation {
        weight,
        presented_at: Timestamp(seconds),
    }
}

fn assert_close(actual: f64, expected: f64, fixture: &str) {
    assert!(
        (actual - expected).abs() < 1e-12,
        "{fixture}: activation {actual} != hand-computed {expected}"
    );
}

#[test]
fn empty_presentations_are_no_base_evidence_not_nan() {
    let error = activation(&[], Timestamp(10), 0.5, AgeUnit::Seconds)
        .expect_err("empty presentations must not produce a score");
    assert_eq!(error, ActivationError::NoPresentations);
}

#[test]
fn unit_age_full_weight_is_ln_one() {
    // age = 1, w = 1, d = 0.5 → 1 * 1^(-0.5) = 1 → ln(1) = 0
    let score = activation(&[presented(1.0, 9)], Timestamp(10), 0.5, AgeUnit::Seconds)
        .expect("unit-age fixture");
    assert_close(score, 0.0, "unit age full weight");
}

#[test]
fn age_four_full_weight_is_ln_half() {
    // age = 4, w = 1, d = 0.5 → 4^(-0.5) = 1/2 → ln(1/2)
    let score = activation(&[presented(1.0, 6)], Timestamp(10), 0.5, AgeUnit::Seconds)
        .expect("age-four fixture");
    assert_close(score, -2.0_f64.ln(), "age four full weight");
}

#[test]
fn mixed_full_and_half_weights_match_hand_sum() {
    // ages 4 and 9, weights 1.0 and 0.5, d = 0.5
    // 1 * 4^(-0.5) + 0.5 * 9^(-0.5) = 1/2 + 0.5 * 1/3 = 2/3
    let score = activation(
        &[presented(1.0, 6), presented(0.5, 1)],
        Timestamp(10),
        0.5,
        AgeUnit::Seconds,
    )
    .expect("mixed-weight fixture");
    assert_close(score, (2.0_f64 / 3.0).ln(), "full plus half ACT-R");
}

#[test]
fn supplied_now_changes_activation_without_a_clock() {
    let presentations = [presented(1.0, 10)];
    let at_age_four =
        activation(&presentations, Timestamp(14), 0.5, AgeUnit::Seconds).expect("now=14");
    let at_age_nine =
        activation(&presentations, Timestamp(19), 0.5, AgeUnit::Seconds).expect("now=19");
    assert_close(at_age_four, -2.0_f64.ln(), "now moves age to 4");
    assert_close(at_age_nine, (1.0_f64 / 3.0).ln(), "now moves age to 9");
    assert!(at_age_nine < at_age_four, "older age must decay the score");
}

#[test]
fn non_finite_decay_is_rejected() {
    let error = activation(
        &[presented(1.0, 1)],
        Timestamp(2),
        f64::NAN,
        AgeUnit::Seconds,
    )
    .expect_err("NaN decay");
    assert_eq!(error, ActivationError::NonFiniteDecay);
}

#[test]
fn non_positive_decay_is_rejected() {
    let zero = activation(&[presented(1.0, 1)], Timestamp(2), 0.0, AgeUnit::Seconds)
        .expect_err("zero decay");
    let negative = activation(&[presented(1.0, 1)], Timestamp(2), -0.5, AgeUnit::Seconds)
        .expect_err("negative decay");
    assert_eq!(zero, ActivationError::NonPositiveDecay);
    assert_eq!(negative, ActivationError::NonPositiveDecay);
}

#[test]
fn negative_weight_is_rejected() {
    let error = activation(&[presented(-0.1, 1)], Timestamp(2), 0.5, AgeUnit::Seconds)
        .expect_err("negative weight");
    assert_eq!(error, ActivationError::NegativeWeight);
}

#[test]
fn non_finite_weight_is_rejected() {
    let error = activation(
        &[presented(f64::INFINITY, 1)],
        Timestamp(2),
        0.5,
        AgeUnit::Seconds,
    )
    .expect_err("infinite weight");
    assert_eq!(error, ActivationError::NonFiniteWeight);
}

#[test]
fn non_positive_age_is_rejected() {
    let future = activation(&[presented(1.0, 5)], Timestamp(4), 0.5, AgeUnit::Seconds)
        .expect_err("future presentation");
    let zero_age = activation(&[presented(1.0, 4)], Timestamp(4), 0.5, AgeUnit::Seconds)
        .expect_err("zero age");
    assert_eq!(future, ActivationError::NonPositiveAge);
    assert_eq!(zero_age, ActivationError::NonPositiveAge);
}

#[test]
fn zero_mass_does_not_take_ln_of_zero() {
    let error = activation(&[presented(0.0, 1)], Timestamp(2), 0.5, AgeUnit::Seconds)
        .expect_err("zero mass");
    assert_eq!(error, ActivationError::NonPositiveMass);
}
