//! Structural parsing for router base URLs (no external URL crate).

use std::net::Ipv6Addr;

use crate::router::error::RouterConfigError;
use crate::security::parse_ipv4_literal;

/// Rejects userinfo in HTTP(S) authorities without echoing credential material.
pub fn reject_userinfo_in_base_url(base: &str) -> Result<(), RouterConfigError> {
    let authority = parse_base_url_authority(base)?;
    if authority.contains('@') {
        return Err(RouterConfigError::InvalidBaseUrl);
    }
    Ok(())
}

/// Returns true when an HTTP base URL points at a loopback authority.
pub fn cleartext_base_url_is_loopback(base: &str) -> Result<bool, RouterConfigError> {
    reject_userinfo_in_base_url(base)?;
    let host = host_from_authority(&parse_base_url_authority(base)?);
    Ok(authority_host_is_loopback(&host))
}

fn parse_base_url_authority(base: &str) -> Result<String, RouterConfigError> {
    let trimmed = base.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(RouterConfigError::InvalidBaseUrl);
    }
    let scheme_end = trimmed
        .find("://")
        .ok_or(RouterConfigError::InvalidBaseUrl)?
        + 3;
    let rest = &trimmed[scheme_end..];
    rest.split('/')
        .next()
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .ok_or(RouterConfigError::InvalidBaseUrl)
}

fn host_from_authority(authority: &str) -> String {
    if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped.find(']').unwrap_or(stripped.len());
        return stripped[..end].to_owned();
    }
    authority
        .rsplit_once(':')
        .filter(|(_, port)| !port.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()))
        .map_or_else(|| authority.to_owned(), |(host, _)| host.to_owned())
}

fn authority_host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(v6) = host.parse::<Ipv6Addr>() {
        return v6.is_loopback();
    }
    if let Some(v4) = parse_ipv4_literal(host) {
        return v4.is_loopback();
    }
    false
}
