/// Why an MCP HTTP URL was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetError {
    /// The URL is not `https`, and it is not `http` on a loopback host.
    Url,
}

/// Accepts `https` URLs and `http` URLs whose host is loopback.
///
/// # Errors
///
/// Returns [`TargetError::Url`] for any other target.
pub fn validate_connection_target(url: &str) -> Result<(), TargetError> {
    if url.len() > 2048 || url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(TargetError::Url);
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err(TargetError::Url);
    };
    if rest.is_empty() || rest.contains('@') {
        return Err(TargetError::Url);
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host_without_port(host)?;
    if host.is_empty() {
        return Err(TargetError::Url);
    }
    match scheme {
        "https" => Ok(()),
        "http" if is_loopback(host) => Ok(()),
        _ => Err(TargetError::Url),
    }
}

fn host_without_port(host: &str) -> Result<&str, TargetError> {
    if let Some(inner) = host.strip_prefix('[') {
        let Some(end) = inner.find(']') else {
            return Err(TargetError::Url);
        };
        return Ok(&inner[..end]);
    }
    Ok(host.split(':').next().unwrap_or(""))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}
