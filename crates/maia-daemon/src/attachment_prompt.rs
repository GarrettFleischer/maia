//! Pure checks for an uploaded file and the untrusted note the model may see.

use sha2::Digest;
use sha2::Sha256;

/// Largest file the owner may attach.
pub const MAX_ATTACHMENT_BYTES: usize = 10 * 1024 * 1024;
/// Text excerpt copied into the untrusted model note.
pub const TEXT_EXCERPT_BYTES: usize = 32 * 1024;

/// Why an upload was refused before it touched disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadReject {
    /// The body was empty.
    Empty,
    /// The body was over the cap.
    TooLarge,
    /// The type is not on the allowlist.
    Type,
    /// The display name is not safe to store.
    Name,
    /// The bytes look like HTML, SVG, or script.
    Active,
}

/// A file the store may record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedUpload {
    /// Lowercase SHA-256 hex.
    pub sha256_hex: String,
    /// `attachments/{sha256}`.
    pub relative_path: String,
    /// Canonical allowlisted type.
    pub media_type: &'static str,
    /// Sanitized display name.
    pub safe_name: String,
}

/// What the model is allowed to see for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelAttachment {
    /// Labeled untrusted text. It is never mixed into the owner message.
    pub note: String,
    /// PNG bytes, standard base64, only when vision is enabled and the file is PNG.
    pub png_base64: Option<String>,
}

/// Accept bytes or refuse them. The caller writes the file.
pub fn accept_upload(
    name: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<AcceptedUpload, UploadReject> {
    if bytes.is_empty() {
        return Err(UploadReject::Empty);
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(UploadReject::TooLarge);
    }
    let media_type = canonical_type(media_type).ok_or(UploadReject::Type)?;
    let safe_name = safe_name(name).ok_or(UploadReject::Name)?;
    if looks_active(bytes) {
        return Err(UploadReject::Active);
    }
    let sha256_hex = hex(&Sha256::digest(bytes));
    Ok(AcceptedUpload {
        relative_path: format!("attachments/{sha256_hex}"),
        sha256_hex,
        media_type,
        safe_name,
    })
}

/// Build the untrusted model note. Images stay a notice unless `vision` is set, and only PNG can pass through.
pub fn model_attachment(
    name: &str,
    media_type: &str,
    bytes: &[u8],
    vision: bool,
) -> ModelAttachment {
    let label = safe_name(name).unwrap_or_else(|| "attachment".to_owned());
    match media_type {
        "text/plain" => text_note(&label, bytes),
        "application/pdf" => ModelAttachment {
            note: format!("Untrusted PDF {label}. The file was stored and was not read."),
            png_base64: None,
        },
        "image/png" if vision => ModelAttachment {
            note: format!("Untrusted image {label}."),
            png_base64: Some(base64_std(bytes)),
        },
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" => ModelAttachment {
            note: format!(
                "Untrusted image {label}. This model cannot view images, so the picture was not shown."
            ),
            png_base64: None,
        },
        _ => ModelAttachment {
            note: format!("Untrusted file {label}. The file was stored and was not read."),
            png_base64: None,
        },
    }
}

/// Join `relative` under `data_dir`, or refuse a path that would leave that directory.
pub fn attachment_file(data_dir: &std::path::Path, relative: &str) -> Option<std::path::PathBuf> {
    if !relative.starts_with("attachments/") {
        return None;
    }
    let mut path = data_dir.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
            return None;
        }
        path.push(part);
    }
    path.starts_with(data_dir).then_some(path)
}

fn text_note(name: &str, bytes: &[u8]) -> ModelAttachment {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return ModelAttachment {
            note: format!("Untrusted text file {name}. It is not UTF-8, so it was not shown."),
            png_base64: None,
        };
    };
    let (excerpt, truncated) = if text.len() > TEXT_EXCERPT_BYTES {
        let mut end = TEXT_EXCERPT_BYTES;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        (&text[..end], true)
    } else {
        (text, false)
    };
    let suffix = if truncated {
        "\nThe file was truncated."
    } else {
        ""
    };
    ModelAttachment {
        note: format!("Untrusted text file {name}:\n{excerpt}{suffix}"),
        png_base64: None,
    }
}

fn canonical_type(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("image/png"),
        "image/jpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "text/plain" => Some("text/plain"),
        "application/pdf" => Some("application/pdf"),
        _ => None,
    }
}

fn safe_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 120 || trimmed == "." || trimmed == ".." {
        return None;
    }
    if trimmed.bytes().any(|byte| {
        !byte.is_ascii_graphic() || matches!(byte, b'/' | b'\\' | b':' | b'<' | b'>' | b'"')
    }) {
        return None;
    }
    Some(trimmed.to_owned())
}

fn looks_active(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(64)];
    let lower = String::from_utf8_lossy(head).to_ascii_lowercase();
    let trimmed = lower.trim_start();
    trimmed.starts_with("<html")
        || trimmed.starts_with("<svg")
        || trimmed.starts_with("<script")
        || trimmed.starts_with("<?xml")
        || trimmed.starts_with("<!doctype")
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn base64_std(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = u32::from(bytes[index]) << 16
            | u32::from(bytes[index + 1]) << 8
            | u32::from(bytes[index + 2]);
        out.push(DIGITS[((chunk >> 18) & 63) as usize] as char);
        out.push(DIGITS[((chunk >> 12) & 63) as usize] as char);
        out.push(DIGITS[((chunk >> 6) & 63) as usize] as char);
        out.push(DIGITS[(chunk & 63) as usize] as char);
        index += 3;
    }
    let rest = bytes.len() - index;
    if rest == 1 {
        let chunk = u32::from(bytes[index]) << 16;
        out.push(DIGITS[((chunk >> 18) & 63) as usize] as char);
        out.push(DIGITS[((chunk >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rest == 2 {
        let chunk = u32::from(bytes[index]) << 16 | u32::from(bytes[index + 1]) << 8;
        out.push(DIGITS[((chunk >> 18) & 63) as usize] as char);
        out.push(DIGITS[((chunk >> 12) & 63) as usize] as char);
        out.push(DIGITS[((chunk >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn active_text_and_oversize_files_are_refused() {
        assert_eq!(
            accept_upload("page.html", "text/html", b"<html></html>"),
            Err(UploadReject::Type)
        );
        assert_eq!(
            accept_upload("note.txt", "text/plain", b"<script>alert(1)</script>"),
            Err(UploadReject::Active)
        );
        let oversize = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
        assert_eq!(
            accept_upload("note.txt", "text/plain", &oversize),
            Err(UploadReject::TooLarge)
        );
        assert_eq!(
            accept_upload("../note.txt", "text/plain", b"ok"),
            Err(UploadReject::Name)
        );
        let accepted = accept_upload("note.txt", "text/plain", b"hello").expect("text");
        assert!(accepted.relative_path.starts_with("attachments/"));
        assert_eq!(accepted.relative_path.len(), "attachments/".len() + 64);
    }

    #[test]
    fn images_stay_a_notice_unless_png_vision_is_explicit() {
        let hidden = model_attachment("shot.png", "image/png", b"\x89PNG", false);
        assert!(hidden.png_base64.is_none());
        assert!(hidden.note.contains("was not shown"));
        let shown = model_attachment("shot.png", "image/png", b"\x89PNG", true);
        assert_eq!(shown.png_base64.as_deref(), Some("iVBORw=="));
        let jpeg = model_attachment("shot.jpg", "image/jpeg", b"\xff\xd8", true);
        assert!(jpeg.png_base64.is_none());
        let pdf = model_attachment("note.pdf", "application/pdf", b"%PDF", true);
        assert!(pdf.note.contains("was not read"));
    }

    #[test]
    fn a_relative_path_cannot_leave_the_data_directory() {
        let root = Path::new("data");
        assert!(attachment_file(root, "attachments/abc").is_some());
        assert!(attachment_file(root, "attachments/../maia.sqlite").is_none());
        assert!(attachment_file(root, "other/abc").is_none());
    }
}
