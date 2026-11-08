//! Approval rendering injectivity.

use maia_core::security::{ApprovalAction, SinkKind, render_approval};

#[test]
fn render_approval_is_injective_on_digest_and_reveals_bidi() {
    let mut a = ApprovalAction {
        sink: SinkKind::ConsoleExec,
        destination: "example.com:443".to_owned(),
        command: "echo ok".to_owned(),
        digest: [1_u8; 32],
    };
    let mut b = a.clone();
    b.digest[0] = 2;
    let view_a = render_approval(&a);
    let view_b = render_approval(&b);
    assert_ne!(view_a.digest_hex, view_b.digest_hex);

    a.command = "echo \u{202e}rm -rf /".to_owned();
    let visible = render_approval(&a);
    assert!(visible.command.contains("["));
}

#[test]
fn render_approval_injective_on_command_with_same_digest() {
    let digest = [9_u8; 32];
    let a = ApprovalAction {
        sink: SinkKind::ConsoleExec,
        destination: "host:443".to_owned(),
        command: "dir".to_owned(),
        digest,
    };
    let b = ApprovalAction {
        command: "del".to_owned(),
        ..a.clone()
    };
    assert_ne!(render_approval(&a).command, render_approval(&b).command);
    assert_eq!(
        render_approval(&a).digest_hex,
        render_approval(&b).digest_hex
    );
}
