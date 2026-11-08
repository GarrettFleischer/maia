//! Approval rendering helpers.

use crate::security::types::{ApprovalAction, ApprovalView, SinkKind};

/// Renders a canonical action into an approval view (injective on digest).
pub fn render_approval(action: &ApprovalAction) -> ApprovalView {
    let sink_label = match action.sink {
        SinkKind::ConsoleExec => "Console".to_owned(),
        SinkKind::WebNavigate => "Web navigate".to_owned(),
        SinkKind::WebRead => "Web read".to_owned(),
        SinkKind::WebWrite { .. } => "Web write".to_owned(),
        SinkKind::ApiCall { .. } => "API call".to_owned(),
        SinkKind::CredentialedAction => "Credentialed action".to_owned(),
        SinkKind::SecretUse => "Secret use".to_owned(),
        SinkKind::ContextEgress => "Context egress".to_owned(),
        SinkKind::OpenThread => "Open thread".to_owned(),
        SinkKind::PostMessage => "Post message".to_owned(),
        SinkKind::VaultRead => "Vault read".to_owned(),
        SinkKind::CaptchaOrMfa => "Captcha / MFA".to_owned(),
        SinkKind::AdminChange => "Administration".to_owned(),
    };
    ApprovalView {
        sink_label,
        destination: action.destination.clone(),
        command: make_controls_visible(&action.command),
        digest_hex: hex_digest(&action.digest),
    }
}

fn hex_digest(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Makes control and bidi characters visible for approval UI.
fn make_controls_visible(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_control() && ch != '\n' && ch != '\t' {
            out.push_str(&format!("\\u{{{:04x}}}", u32::from(ch)));
        } else if is_bidi_override(ch) {
            out.push_str(&format!("[{ch:?}]"));
        } else {
            out.push(ch);
        }
    }
    out
}

fn is_bidi_override(ch: char) -> bool {
    matches!(
        ch,
        '\u{202a}'
            | '\u{202b}'
            | '\u{202d}'
            | '\u{202e}'
            | '\u{2066}'
            | '\u{2067}'
            | '\u{2068}'
            | '\u{2069}'
    )
}
