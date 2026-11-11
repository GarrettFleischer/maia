//! Honest phone-access decisions. Every fact arrives as a parameter.

use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;

use sha2::Digest;
use sha2::Sha256;

/// How long a pairing code stays valid.
pub const CODE_TTL_SECS: i64 = 600;

/// Failed pairing attempts allowed inside one window.
pub const PAIR_FAILURE_LIMIT: u32 = 5;

/// Window for [`PAIR_FAILURE_LIMIT`].
pub const PAIR_WINDOW_SECS: i64 = 600;

/// Idle lifetime of a phone session.
pub const SESSION_IDLE_SECS: i64 = 12 * 60 * 60;

/// Absolute lifetime of a phone session.
pub const SESSION_ABSOLUTE_SECS: i64 = 7 * 24 * 60 * 60;

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Who Tailscale says is on the other end of a socket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailnetIdentity {
    /// Stable Tailscale user id. Empty when the node has no user.
    pub user_id: String,
    /// Stable Tailscale node id.
    pub node_id: String,
    /// Display name. Never a credential.
    pub node_name: String,
    /// ACL tags. A non-empty list is always denied.
    pub tags: Vec<String>,
}

/// WhoIs result stashed on a tailnet request.
#[derive(Clone, Debug)]
pub struct TailnetPeer(pub TailnetIdentity);

/// Listener that accepted the TCP connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListenerClass {
    /// `127.0.0.1` or `::1`.
    Loopback,
    /// A Tailscale address.
    Tailnet,
}

/// What the tailnet middleware should do with one request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TailnetGate {
    /// Serve the handler.
    Continue,
    /// Stop. `error` is a stable token, not a sentence from Tailscale.
    Reject {
        /// HTTP status.
        status: u16,
        /// Machine-readable reason.
        error: &'static str,
    },
}

/// A paired phone session, already loaded from memory.
#[derive(Clone, Copy, Debug)]
pub struct SessionView<'a> {
    /// Tailscale user id stored at pairing.
    pub user_id: &'a str,
    /// Tailscale node id stored at pairing.
    pub node_id: &'a str,
    /// Session-bound CSRF token.
    pub csrf: &'a str,
    /// Unix seconds when idle expiry hits.
    pub idle_deadline: i64,
    /// Unix seconds when absolute expiry hits.
    pub absolute_deadline: i64,
}

/// Fields the middleware already pulled off the request.
pub struct TailnetRequest<'a> {
    /// HTTP method.
    pub method: &'a str,
    /// Path only, no query.
    pub path: &'a str,
    /// `Host` header.
    pub host: &'a str,
    /// `Origin` header when the browser sent one.
    pub origin: Option<&'a str>,
    /// `Sec-Fetch-Site` when the browser sent one.
    pub fetch_site: Option<&'a str>,
    /// `x-csrf-token` when the page sent one.
    pub csrf: Option<&'a str>,
}

/// Names this process is actually listening as.
pub struct HostNames<'a> {
    /// MagicDNS name without a trailing dot.
    pub dns_name: &'a str,
    /// UI port.
    pub port: u16,
    /// Tailscale addresses bound for that port.
    pub ips: &'a [IpAddr],
}

/// Map an IPv4-mapped IPv6 address back to IPv4.
pub fn canonical_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(value) => value.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        other => other,
    }
}

/// `100.64.0.0/10` or Tailscale's `fd7a:115c:a1e0::/48` prefix.
pub fn is_tailscale_ip(ip: IpAddr) -> bool {
    match canonical_ip(ip) {
        IpAddr::V4(value) => is_cgnat(value),
        IpAddr::V6(value) => is_tailscale_ula(value),
    }
}

/// Keep only Tailscale addresses, in input order, without duplicates.
pub fn tailscale_addrs(ips: &[IpAddr]) -> Vec<IpAddr> {
    let mut kept = Vec::new();
    for ip in ips {
        let ip = canonical_ip(*ip);
        if is_tailscale_ip(ip) && !kept.contains(&ip) {
            kept.push(ip);
        }
    }
    kept
}

/// Eight-character code from 8 entropy bytes. Alphabet size is 32, so each byte is unbiased.
pub fn pairing_code(entropy: &[u8; 8]) -> String {
    let mut code = String::with_capacity(9);
    for (index, byte) in entropy.iter().enumerate() {
        if index == 4 {
            code.push('-');
        }
        let symbol = CODE_ALPHABET[usize::from(byte % 32)];
        code.push(char::from(symbol));
    }
    code
}

/// SHA-256 of the normalized code.
pub fn code_hash(code: &str) -> [u8; 32] {
    let digest = Sha256::digest(normalize_code(code).as_bytes());
    let mut hash = [0; 32];
    hash.copy_from_slice(&digest);
    hash
}

/// Match a code without leaking the expected hash through a short-circuit compare.
pub fn code_matches(offered: &str, expected: &[u8; 32], now: i64, expires_at: i64) -> bool {
    let actual = code_hash(offered);
    bytes_equal(&actual, expected) && now < expires_at
}

/// True when another failed attempt is still inside the budget.
pub fn failures_allow(count: u32, window_start: i64, now: i64) -> bool {
    if now.saturating_sub(window_start) >= PAIR_WINDOW_SECS {
        return true;
    }
    count < PAIR_FAILURE_LIMIT
}

/// `Host` must be this process's MagicDNS name or Tailscale address, with the UI port.
pub fn host_allowed(host: &str, names: &HostNames<'_>) -> bool {
    let host = host.trim();
    if host.is_empty() || host.contains(['@', '/', ' ']) {
        return false;
    }
    let dns = format!("{}:{}", names.dns_name, names.port);
    if host.eq_ignore_ascii_case(&dns) {
        return true;
    }
    names.ips.iter().any(|ip| {
        let expected = match ip {
            IpAddr::V4(value) => format!("{value}:{}", names.port),
            IpAddr::V6(value) => format!("[{value}]:{}", names.port),
        };
        host.eq_ignore_ascii_case(&expected)
    })
}

/// Map Tailscale's certificate failure to a fixed sentence. The raw error stays out of the API.
pub fn certificate_failure_reason(stderr: &str) -> &'static str {
    if stderr.contains("does not support getting TLS certs")
        || stderr.contains("HTTPS is not enabled")
    {
        "Turn on Enable HTTPS in the Tailscale DNS admin page. Maia will keep trying."
    } else {
        "A Tailscale certificate is not available."
    }
}

/// A Serve or Funnel config that mentions this port disables remote access.
pub fn serve_blocks_remote(text: &str, port: u16) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("No serve config") {
        return false;
    }
    let port_text = port.to_string();
    trimmed
        .split(|ch: char| !ch.is_ascii_digit())
        .any(|token| token == port_text)
}

/// Decide a tailnet request. Tagged nodes and bad hosts never reach a handler.
pub fn gate_tailnet(
    request: &TailnetRequest<'_>,
    identity: &TailnetIdentity,
    paired: bool,
    session: Option<SessionView<'_>>,
    names: &HostNames<'_>,
    now: i64,
) -> TailnetGate {
    if !identity.tags.is_empty() || identity.user_id.is_empty() || identity.node_id.is_empty() {
        return reject(403, "denied");
    }
    if !host_allowed(request.host, names) {
        return reject(403, "denied");
    }
    if fetch_site_is_cross_origin(request.fetch_site) {
        return reject(403, "denied");
    }
    if origin_is_foreign(request.origin, names) {
        return reject(403, "denied");
    }
    if is_open_tailnet_route(request.method, request.path) {
        return TailnetGate::Continue;
    }
    if !request.path.starts_with("/api") {
        return TailnetGate::Continue;
    }
    let Some(session) = session else {
        return reject(401, "unpaired");
    };
    if !paired || session.user_id != identity.user_id || session.node_id != identity.node_id {
        return reject(401, "unpaired");
    }
    if now >= session.idle_deadline || now >= session.absolute_deadline {
        return reject(401, "session_expired");
    }
    if mutates(request.method) && !csrf_matches(request.csrf, session.csrf) {
        return reject(403, "denied");
    }
    TailnetGate::Continue
}

/// Read one cookie value. The name match is exact.
pub fn cookie_value<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key.trim() == name).then_some(value.trim())
    })
}

/// Fixed-length compare.
pub fn bytes_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (left, right) in left.iter().zip(right.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

/// `tailscale status --json` fields this daemon needs. Extra fields are ignored.
pub fn parse_status(bytes: &[u8]) -> Option<TailscaleSnapshot> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let this = value.get("Self")?;
    let dns_name = magic_dns_name(this.get("DNSName")?.as_str()?)?;
    let ips = this
        .get("TailscaleIPs")?
        .as_array()?
        .iter()
        .filter_map(|item| item.as_str())
        .filter_map(|text| text.parse::<IpAddr>().ok())
        .collect::<Vec<_>>();
    Some(TailscaleSnapshot {
        dns_name,
        online: this.get("Online").and_then(serde_json::Value::as_bool) == Some(true),
        backend_running: value
            .get("BackendState")
            .and_then(serde_json::Value::as_str)
            == Some("Running"),
        ips: tailscale_addrs(&ips),
    })
}

/// `tailscale whois --json` identity. Tagged nodes stay tagged so the gate can deny them.
pub fn parse_whois(bytes: &[u8]) -> Option<TailnetIdentity> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let node = value.get("Node")?;
    let node_id = node
        .get("StableID")
        .and_then(serde_json::Value::as_str)?
        .trim();
    if node_id.is_empty() {
        return None;
    }
    let tags = node
        .get("Tags")
        .and_then(serde_json::Value::as_array)
        .map(|tags| {
            tags.iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|tag| !tag.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let user_id = value
        .get("UserProfile")
        .and_then(|profile| profile.get("ID"))
        .and_then(json_id)
        .filter(|id| id != "0")
        .unwrap_or_default();
    let node_name = node
        .get("Hostinfo")
        .and_then(|info| info.get("Hostname"))
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            node.get("Name")
                .and_then(serde_json::Value::as_str)
                .and_then(magic_dns_name)
        })
        .unwrap_or_else(|| "phone".to_owned());
    Some(TailnetIdentity {
        user_id,
        node_id: node_id.to_owned(),
        node_name,
        tags,
    })
}

/// Status fields used to bind the phone listener.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TailscaleSnapshot {
    /// MagicDNS name without a trailing dot.
    pub dns_name: String,
    /// Tailscale reports the node online.
    pub online: bool,
    /// Local daemon backend is `Running`.
    pub backend_running: bool,
    /// Tailscale addresses only.
    pub ips: Vec<IpAddr>,
}

fn reject(status: u16, error: &'static str) -> TailnetGate {
    TailnetGate::Reject { status, error }
}

fn is_cgnat(ip: Ipv4Addr) -> bool {
    let [first, second, _, _] = ip.octets();
    first == 100 && (64..128).contains(&second)
}

fn is_tailscale_ula(ip: Ipv6Addr) -> bool {
    let octets = ip.octets();
    octets[..6] == [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0]
}

fn normalize_code(code: &str) -> String {
    code.chars()
        .filter(|ch| !ch.is_whitespace() && *ch != '-')
        .flat_map(char::to_uppercase)
        .collect()
}

fn mutates(method: &str) -> bool {
    matches!(method, "POST" | "PUT" | "PATCH" | "DELETE")
}

fn is_open_tailnet_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/remote/session")
            | ("GET", "/api/remote/status")
            | ("POST", "/api/remote/pair")
    )
}

fn fetch_site_is_cross_origin(fetch_site: Option<&str>) -> bool {
    matches!(fetch_site, Some("cross-site" | "same-site"))
}

fn origin_is_foreign(origin: Option<&str>, names: &HostNames<'_>) -> bool {
    let Some(origin) = origin else {
        return false;
    };
    let Some(host) = origin.strip_prefix("https://") else {
        return true;
    };
    !host_allowed(host, names)
}

fn csrf_matches(header: Option<&str>, expected: &str) -> bool {
    let Some(header) = header else {
        return false;
    };
    bytes_equal(header.as_bytes(), expected.as_bytes())
}

fn magic_dns_name(name: &str) -> Option<String> {
    let trimmed = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if trimmed.is_empty() || trimmed.contains(['/', ' ', '@']) {
        return None;
    }
    Some(trimmed)
}

fn json_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone() -> TailnetIdentity {
        TailnetIdentity {
            user_id: "user-1".to_owned(),
            node_id: "node-1".to_owned(),
            node_name: "Pixel".to_owned(),
            tags: Vec::new(),
        }
    }

    fn ip(text: &str) -> IpAddr {
        match text.parse() {
            Ok(ip) => ip,
            Err(_) => panic!("bad address {text}"),
        }
    }

    fn host_names(ips: &[IpAddr]) -> HostNames<'_> {
        HostNames {
            dns_name: "gamma.example.ts.net",
            port: 4178,
            ips,
        }
    }

    fn session<'a>(csrf: &'a str) -> SessionView<'a> {
        SessionView {
            user_id: "user-1",
            node_id: "node-1",
            csrf,
            idle_deadline: 2_000,
            absolute_deadline: 5_000,
        }
    }

    #[test]
    fn tailscale_ranges_exclude_lan_and_wildcard() {
        let kept = tailscale_addrs(&[
            ip("127.0.0.1"),
            ip("0.0.0.0"),
            ip("192.168.1.20"),
            ip("10.0.0.4"),
            ip("100.63.1.1"),
            ip("100.128.0.1"),
            ip("100.64.0.1"),
            ip("100.127.255.255"),
            ip("100.77.132.115"),
            ip("fd7a:115c:a1e1::1"),
            ip("fd7a:115c:a1e0::c239:8475"),
            ip("::ffff:100.77.132.115"),
        ]);
        assert_eq!(
            kept,
            vec![
                ip("100.64.0.1"),
                ip("100.127.255.255"),
                ip("100.77.132.115"),
                ip("fd7a:115c:a1e0::c239:8475"),
            ]
        );
    }

    #[test]
    fn host_allows_magic_dns_and_tailscale_literals_only() {
        let ips = vec![ip("100.77.132.115"), ip("fd7a:115c:a1e0::1")];
        let names = host_names(&ips);
        assert!(host_allowed("gamma.example.ts.net:4178", &names));
        assert!(host_allowed("100.77.132.115:4178", &names));
        assert!(host_allowed("[fd7a:115c:a1e0::1]:4178", &names));
        assert!(!host_allowed("gamma.example.ts.net", &names));
        assert!(!host_allowed("gamma.example.ts.net:443", &names));
        assert!(!host_allowed("evil.ts.net:4178", &names));
        assert!(!host_allowed("127.0.0.1:4178", &names));
        assert!(!host_allowed("192.168.1.8:4178", &names));
    }

    #[test]
    fn certificate_failure_names_the_admin_switch_without_echoing_the_process_error() {
        let reason = certificate_failure_reason(
            "500 Internal Server Error: your Tailscale account does not support getting TLS certs\n",
        );
        assert_eq!(
            reason,
            "Turn on Enable HTTPS in the Tailscale DNS admin page. Maia will keep trying."
        );
        assert!(!reason.contains("500"));
        assert_eq!(
            certificate_failure_reason("boom"),
            "A Tailscale certificate is not available."
        );
    }

    #[test]
    fn serve_text_blocks_only_when_it_mentions_the_maia_port() {
        assert!(!serve_blocks_remote("No serve config", 4178));
        assert!(!serve_blocks_remote("", 4178));
        assert!(!serve_blocks_remote("{\"TCP\":{\"443\":{}}}", 4178));
        assert!(serve_blocks_remote("proxy http://127.0.0.1:4178", 4178));
        assert!(serve_blocks_remote("{\"TCP\":{\"4178\":{}}}", 4178));
    }

    #[test]
    fn pairing_code_matches_ignores_case_and_dashes_until_expiry() {
        let code = pairing_code(&[1, 2, 3, 4, 5, 6, 7, 8]);
        let hash = code_hash(&code);
        assert!(code_matches(&code.to_lowercase(), &hash, 10, 20));
        assert!(code_matches(&code.replace('-', " "), &hash, 10, 20));
        assert!(!code_matches("ZZZZ-ZZZZ", &hash, 10, 20));
        assert!(!code_matches(&code, &hash, 20, 20));
    }

    #[test]
    fn failure_window_locks_the_fifth_miss_and_then_resets() {
        assert!(failures_allow(4, 1_000, 1_100));
        assert!(!failures_allow(5, 1_000, 1_100));
        assert!(failures_allow(5, 1_000, 1_000 + PAIR_WINDOW_SECS));
    }

    #[test]
    fn tagged_and_anonymous_nodes_are_denied_before_pairing() {
        let ips = vec![ip("100.77.132.115")];
        let names = host_names(&ips);
        let request = TailnetRequest {
            method: "GET",
            path: "/",
            host: "gamma.example.ts.net:4178",
            origin: None,
            fetch_site: None,
            csrf: None,
        };
        let mut tagged = phone();
        tagged.tags.push("tag:server".to_owned());
        assert_eq!(
            gate_tailnet(&request, &tagged, true, None, &names, 1_500),
            TailnetGate::Reject {
                status: 403,
                error: "denied"
            }
        );
        let mut anonymous = phone();
        anonymous.user_id.clear();
        assert_eq!(
            gate_tailnet(&request, &anonymous, false, None, &names, 1_500),
            TailnetGate::Reject {
                status: 403,
                error: "denied"
            }
        );
    }

    #[test]
    fn unpaired_phone_can_open_the_gate_and_nothing_else() {
        let ips = vec![ip("100.77.132.115")];
        let names = host_names(&ips);
        let identity = phone();
        let session = TailnetRequest {
            method: "GET",
            path: "/api/remote/session",
            host: "gamma.example.ts.net:4178",
            origin: Some("https://gamma.example.ts.net:4178"),
            fetch_site: Some("same-origin"),
            csrf: None,
        };
        assert_eq!(
            gate_tailnet(&session, &identity, false, None, &names, 1_500),
            TailnetGate::Continue
        );
        let sidebar = TailnetRequest {
            method: "GET",
            path: "/api/super-agent/sidebar",
            host: "gamma.example.ts.net:4178",
            origin: Some("https://gamma.example.ts.net:4178"),
            fetch_site: Some("same-origin"),
            csrf: None,
        };
        assert_eq!(
            gate_tailnet(&sidebar, &identity, false, None, &names, 1_500),
            TailnetGate::Reject {
                status: 401,
                error: "unpaired"
            }
        );
        let page = TailnetRequest {
            method: "GET",
            path: "/",
            host: "gamma.example.ts.net:4178",
            origin: None,
            fetch_site: Some("none"),
            csrf: None,
        };
        assert_eq!(
            gate_tailnet(&page, &identity, false, None, &names, 1_500),
            TailnetGate::Continue
        );
    }

    #[test]
    fn paired_mutation_requires_the_session_csrf_and_same_node() {
        let ips = vec![ip("100.77.132.115")];
        let names = host_names(&ips);
        let identity = phone();
        let post = TailnetRequest {
            method: "POST",
            path: "/api/super-agent/messages",
            host: "gamma.example.ts.net:4178",
            origin: Some("https://gamma.example.ts.net:4178"),
            fetch_site: Some("same-origin"),
            csrf: Some("csrf-token"),
        };
        assert_eq!(
            gate_tailnet(
                &post,
                &identity,
                true,
                Some(session("csrf-token")),
                &names,
                1_500
            ),
            TailnetGate::Continue
        );
        let missing = TailnetRequest { csrf: None, ..post };
        assert_eq!(
            gate_tailnet(
                &missing,
                &identity,
                true,
                Some(session("csrf-token")),
                &names,
                1_500
            ),
            TailnetGate::Reject {
                status: 403,
                error: "denied"
            }
        );
        let other = TailnetRequest {
            method: "GET",
            path: "/api/super-agent/sidebar",
            host: "gamma.example.ts.net:4178",
            origin: None,
            fetch_site: None,
            csrf: None,
        };
        assert_eq!(
            gate_tailnet(
                &other,
                &identity,
                true,
                Some(session("csrf-token")),
                &names,
                1_500
            ),
            TailnetGate::Continue
        );
        let late = 2_000;
        assert_eq!(
            gate_tailnet(
                &other,
                &identity,
                true,
                Some(session("csrf-token")),
                &names,
                late
            ),
            TailnetGate::Reject {
                status: 401,
                error: "session_expired"
            }
        );
    }

    #[test]
    fn cross_site_fetch_is_denied() {
        let ips = vec![ip("100.77.132.115")];
        let names = host_names(&ips);
        let request = TailnetRequest {
            method: "POST",
            path: "/api/remote/pair",
            host: "gamma.example.ts.net:4178",
            origin: Some("https://evil.example"),
            fetch_site: Some("cross-site"),
            csrf: None,
        };
        assert_eq!(
            gate_tailnet(&request, &phone(), false, None, &names, 1_500),
            TailnetGate::Reject {
                status: 403,
                error: "denied"
            }
        );
    }

    #[test]
    fn whois_parse_keeps_tags_and_drops_a_missing_user() {
        let tagged = br#"{"Node":{"StableID":"node-9","Name":"box.ts.net.","Tags":["tag:ci"],"Hostinfo":{"Hostname":"box"}},"UserProfile":{"ID":42}}"#;
        let identity = parse_whois(tagged).unwrap_or_else(|| panic!("whois"));
        assert_eq!(identity.tags, vec!["tag:ci".to_owned()]);
        assert_eq!(identity.user_id, "42");
        assert_eq!(identity.node_name, "box");
        let anonymous = br#"{"Node":{"StableID":"node-9","Name":"box.ts.net.","Tags":null},"UserProfile":{"ID":0}}"#;
        let identity = parse_whois(anonymous).unwrap_or_else(|| panic!("whois"));
        assert!(identity.user_id.is_empty());
        assert!(identity.tags.is_empty());
    }

    #[test]
    fn status_parse_strips_the_dns_dot_and_drops_non_tailscale_ips() {
        let raw = br#"{"BackendState":"Running","Self":{"DNSName":"Gamma.Example.ts.net.","Online":true,"TailscaleIPs":["100.77.132.115","192.168.1.2","fd7a:115c:a1e0::1"]}}"#;
        let snapshot = parse_status(raw).unwrap_or_else(|| panic!("status"));
        assert_eq!(snapshot.dns_name, "gamma.example.ts.net");
        assert!(snapshot.online && snapshot.backend_running);
        assert_eq!(snapshot.ips.len(), 2);
        let offline = br#"{"BackendState":"Stopped","Self":{"DNSName":"gamma.example.ts.net.","Online":false,"TailscaleIPs":["100.1.1.1"]}}"#;
        let snapshot = parse_status(offline).unwrap_or_else(|| panic!("status"));
        assert!(!snapshot.online);
        assert!(!snapshot.backend_running);
    }
}
