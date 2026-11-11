//! Phone-access file, sessions, and Tailscale commands.

use std::collections::HashMap;
use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use serde::Deserialize;
use serde::Serialize;
use tokio::sync::mpsc;

use super::admit::CODE_TTL_SECS;
use super::admit::SESSION_ABSOLUTE_SECS;
use super::admit::SESSION_IDLE_SECS;
use super::admit::TailnetIdentity;
use super::admit::canonical_ip;
use super::admit::certificate_failure_reason;
use super::admit::code_hash;
use super::admit::code_matches;
use super::admit::failures_allow;
use super::admit::pairing_code;
use super::admit::parse_status;
use super::admit::parse_whois;
use super::admit::serve_blocks_remote;

const WHOIS_CACHE_SECS: i64 = 30;
const COOKIE_NAME: &str = "__Host-maia";

/// In-memory phone access shared by the loopback API and the Tailscale listener.
#[derive(Clone)]
pub struct RemoteHub {
    inner: Arc<RemoteInner>,
}

struct RemoteInner {
    path: PathBuf,
    cert_dir: PathBuf,
    port: u16,
    program: String,
    file: Mutex<PhoneFile>,
    corrupt: Mutex<bool>,
    sessions: Mutex<HashMap<String, LiveSession>>,
    whois_cache: Mutex<Vec<WhoisCache>>,
    failures: Mutex<HashMap<String, FailWindow>>,
    report: Mutex<LiveReport>,
    bound: Mutex<Option<BoundNames>>,
    enable_tx: mpsc::Sender<()>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PhoneFile {
    enabled: bool,
    #[serde(default)]
    paired: Vec<StoredDevice>,
    #[serde(default)]
    code_hash: Option<String>,
    #[serde(default)]
    code_expires_unix: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredDevice {
    user_id: String,
    node_id: String,
    name: String,
    paired_at: i64,
}

struct LiveSession {
    user_id: String,
    node_id: String,
    csrf: String,
    idle_deadline: i64,
    absolute_deadline: i64,
}

struct WhoisCache {
    ip: IpAddr,
    at: i64,
    identity: TailnetIdentity,
}

struct FailWindow {
    start: i64,
    count: u32,
}

struct LiveReport {
    phase: Phase,
    url: Option<String>,
    reason: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Disabled,
    Starting,
    Ready,
    Unavailable,
}

struct BoundNames {
    dns_name: String,
    ips: Vec<IpAddr>,
}

/// What the desktop Settings page can show. No codes, keys, or user ids.
pub struct DesktopStatus {
    /// The owner turned phone access on.
    pub enabled: bool,
    /// `disabled`, `starting`, `ready`, or `unavailable`.
    pub phase: &'static str,
    /// `https://magic-dns:port/` when the listener is up.
    pub url: Option<String>,
    /// A fixed sentence when the listener is down.
    pub reason: Option<String>,
    /// A pairing code exists and has not expired.
    pub code_active: bool,
    /// Paired phones.
    pub devices: Vec<DeviceView>,
}

/// One paired phone, without its Tailscale user id.
pub struct DeviceView {
    /// Stable node id, used to unpair.
    pub node_id: String,
    /// Hostname from WhoIs.
    pub name: String,
    /// Unix seconds.
    pub paired_at: i64,
}

/// Result of enabling phone access.
pub enum EnableResult {
    /// The supervisor was asked to bind Tailscale.
    Started,
    /// The certificate-publication acknowledgement was missing.
    NeedsAcknowledgement,
    /// The settings file could not be saved.
    Unavailable,
}

/// A pairing code that is shown once.
pub enum IssuedCode {
    /// Desktop may display this code.
    Shown { code: String, expires_at: i64 },
    /// Phone access is off.
    NotEnabled,
    /// Entropy or the settings file failed.
    Unavailable,
}

/// Pair or session establishment.
pub enum SessionIssued {
    /// Cookie token plus CSRF token.
    Connected {
        token: String,
        csrf: String,
        max_age: i64,
    },
    /// This node is not paired.
    Unpaired,
    /// The code did not match.
    InvalidCode,
    /// Too many recent misses.
    Locked,
    /// Tagged, anonymous, or storage failure.
    Denied,
}

/// Who may unpair a node.
pub enum UnpairActor {
    /// Loopback desktop.
    Desktop,
    /// The paired phone itself, or another paired owner.
    Phone { node_id: String },
}

/// Session fields for the gate.
pub struct OwnedSession {
    /// Paired user.
    pub user_id: String,
    /// Paired node.
    pub node_id: String,
    /// CSRF token.
    pub csrf: String,
    /// Idle deadline, unix seconds.
    pub idle_deadline: i64,
    /// Absolute deadline, unix seconds.
    pub absolute_deadline: i64,
}

/// Names the tailnet listener is serving.
pub struct OwnedNames {
    /// MagicDNS name.
    pub dns_name: String,
    /// UI port.
    pub port: u16,
    /// Bound Tailscale addresses.
    pub ips: Vec<IpAddr>,
}

/// Rustls config plus the names it is valid for.
pub struct PreparedTls {
    /// Server config. The private key stays inside it.
    pub config: std::sync::Arc<rustls::ServerConfig>,
    /// MagicDNS name.
    pub dns_name: String,
    /// Addresses to bind.
    pub ips: Vec<IpAddr>,
}

impl RemoteHub {
    /// Load `phone-access.json` from `dir`. Missing means phone access is off.
    pub fn open(dir: &Path, port: u16) -> (Self, mpsc::Receiver<()>) {
        let (enable_tx, enable_rx) = mpsc::channel(1);
        let path = dir.join("phone-access.json");
        let (file, corrupt) = match load_file(&path) {
            Load::Ready(file) => (file, false),
            Load::Missing => (PhoneFile::disabled(), false),
            Load::Corrupt => (PhoneFile::disabled(), true),
        };
        let phase = if corrupt {
            Phase::Unavailable
        } else if file.enabled {
            Phase::Starting
        } else {
            Phase::Disabled
        };
        let reason = corrupt.then(|| "Phone access settings could not be read.".to_owned());
        let hub = Self {
            inner: Arc::new(RemoteInner {
                path,
                cert_dir: dir.join("tailscale"),
                port,
                program: "tailscale".to_owned(),
                file: Mutex::new(file),
                corrupt: Mutex::new(corrupt),
                sessions: Mutex::new(HashMap::new()),
                whois_cache: Mutex::new(Vec::new()),
                failures: Mutex::new(HashMap::new()),
                report: Mutex::new(LiveReport {
                    phase,
                    url: None,
                    reason,
                }),
                bound: Mutex::new(None),
                enable_tx,
            }),
        };
        (hub, enable_rx)
    }

    /// UI port.
    pub fn port(&self) -> u16 {
        self.inner.port
    }

    /// Persisted owner choice.
    pub fn is_enabled(&self) -> bool {
        let enabled = self.inner.file.lock().ok().is_some_and(|file| file.enabled);
        enabled && !self.corrupt()
    }

    /// Desktop projection.
    pub fn desktop_status(&self, now: i64) -> DesktopStatus {
        let Some(file) = self.inner.file.lock().ok() else {
            return DesktopStatus::unavailable("Phone access settings could not be read.");
        };
        let Some(report) = self.inner.report.lock().ok() else {
            return DesktopStatus::unavailable("Phone access settings could not be read.");
        };
        DesktopStatus {
            enabled: file.enabled,
            phase: report.phase.name(),
            url: report.url.clone(),
            reason: report.reason.clone(),
            code_active: file.code_is_active(now),
            devices: file.devices(),
        }
    }

    /// Paired phones see the device list. An unpaired phone sees only its own name.
    pub fn phone_state(&self, identity: &TailnetIdentity) -> PhoneState {
        if !identity.tags.is_empty() || identity.user_id.is_empty() {
            return PhoneState::Denied;
        }
        let Some(file) = self.inner.file.lock().ok() else {
            return PhoneState::Denied;
        };
        if !file.is_paired(&identity.user_id, &identity.node_id) {
            return PhoneState::Unpaired {
                node_name: identity.node_name.clone(),
            };
        }
        let url = self
            .inner
            .report
            .lock()
            .ok()
            .and_then(|report| report.url.clone());
        PhoneState::Paired {
            url,
            devices: file.devices(),
        }
    }

    /// Turn phone access on after the owner acknowledges certificate publication.
    pub fn enable(&self, acknowledged: bool) -> EnableResult {
        if !acknowledged {
            return EnableResult::NeedsAcknowledgement;
        }
        let Some(mut file) = self.inner.file.lock().ok() else {
            return EnableResult::Unavailable;
        };
        file.enabled = true;
        if !self.store(&file) {
            return EnableResult::Unavailable;
        }
        if let Ok(mut corrupt) = self.inner.corrupt.lock() {
            *corrupt = false;
        }
        let already_ready = self
            .inner
            .report
            .lock()
            .ok()
            .is_some_and(|report| report.phase == Phase::Ready);
        if !already_ready {
            self.set_phase(Phase::Starting, None, None);
        }
        let _ = self.inner.enable_tx.try_send(());
        EnableResult::Started
    }

    /// Create a new pairing code and forget the previous one.
    pub fn issue_code(&self, now: i64) -> IssuedCode {
        if !self.is_enabled() {
            return IssuedCode::NotEnabled;
        }
        let Some(entropy) = random_bytes::<8>() else {
            return IssuedCode::Unavailable;
        };
        let code = pairing_code(&entropy);
        let Some(mut file) = self.inner.file.lock().ok() else {
            return IssuedCode::Unavailable;
        };
        file.code_hash = Some(hex(&code_hash(&code)));
        file.code_expires_unix = Some(now.saturating_add(CODE_TTL_SECS));
        if !self.store(&file) {
            return IssuedCode::Unavailable;
        }
        IssuedCode::Shown {
            code,
            expires_at: now.saturating_add(CODE_TTL_SECS),
        }
    }

    /// Record `(user, node)` when the code matches, then issue a session.
    pub fn accept_pair(&self, identity: &TailnetIdentity, code: &str, now: i64) -> SessionIssued {
        if !identity.tags.is_empty() || identity.user_id.is_empty() || identity.node_id.is_empty() {
            return SessionIssued::Denied;
        }
        if code.len() > 32 {
            return SessionIssued::InvalidCode;
        }
        if !self.allow_attempt(&identity.node_id, now) {
            return SessionIssued::Locked;
        }
        let Some(file) = self.inner.file.lock().ok() else {
            return SessionIssued::Denied;
        };
        let Some(expected) = file.code_hash.as_deref().and_then(decode_hex) else {
            drop(file);
            self.note_failure(&identity.node_id, now);
            return SessionIssued::InvalidCode;
        };
        let expires = file.code_expires_unix.unwrap_or(0);
        let matched = code_matches(code, &expected, now, expires);
        drop(file);
        if !matched {
            self.note_failure(&identity.node_id, now);
            return SessionIssued::InvalidCode;
        }
        self.clear_failures(&identity.node_id);
        let Some(mut file) = self.inner.file.lock().ok() else {
            return SessionIssued::Denied;
        };
        file.code_hash = None;
        file.code_expires_unix = None;
        if let Some(existing) = file
            .paired
            .iter_mut()
            .find(|device| device.user_id == identity.user_id && device.node_id == identity.node_id)
        {
            existing.name = identity.node_name.clone();
        } else {
            file.paired.push(StoredDevice {
                user_id: identity.user_id.clone(),
                node_id: identity.node_id.clone(),
                name: identity.node_name.clone(),
                paired_at: now,
            });
        }
        if !self.store(&file) {
            return SessionIssued::Denied;
        }
        drop(file);
        self.issue_session(identity, now)
    }

    /// Issue a session for a node that is already paired.
    pub fn establish(&self, identity: &TailnetIdentity, now: i64) -> SessionIssued {
        if !identity.tags.is_empty() || identity.user_id.is_empty() {
            return SessionIssued::Denied;
        }
        let paired = self
            .inner
            .file
            .lock()
            .ok()
            .is_some_and(|file| file.is_paired(&identity.user_id, &identity.node_id));
        if !paired {
            return SessionIssued::Unpaired;
        }
        self.issue_session(identity, now)
    }

    /// Remove a paired node and its sessions.
    pub fn unpair(&self, actor: UnpairActor, node_id: &str) -> bool {
        if node_id.is_empty() || node_id.len() > 200 {
            return false;
        }
        if let UnpairActor::Phone {
            node_id: actor_node,
        } = &actor
        {
            if actor_node != node_id {
                let allowed = self.inner.file.lock().ok().is_some_and(|file| {
                    file.paired
                        .iter()
                        .any(|device| device.node_id == *actor_node)
                });
                if !allowed {
                    return false;
                }
            }
        }
        let Some(mut file) = self.inner.file.lock().ok() else {
            return false;
        };
        let before = file.paired.len();
        file.paired.retain(|device| device.node_id != node_id);
        if file.paired.len() == before {
            return false;
        }
        if !self.store(&file) {
            return false;
        }
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            sessions.retain(|_, session| session.node_id != node_id);
        }
        true
    }

    /// Copy a session for the gate. Expired rows are still returned so the gate can name expiry.
    pub fn session(&self, token: &str) -> Option<OwnedSession> {
        let sessions = self.inner.sessions.lock().ok()?;
        let session = sessions.get(token)?;
        Some(OwnedSession {
            user_id: session.user_id.clone(),
            node_id: session.node_id.clone(),
            csrf: session.csrf.clone(),
            idle_deadline: session.idle_deadline,
            absolute_deadline: session.absolute_deadline,
        })
    }

    /// Extend idle expiry without passing the absolute deadline.
    pub fn touch(&self, token: &str, now: i64) {
        let Some(mut sessions) = self.inner.sessions.lock().ok() else {
            return;
        };
        let Some(session) = sessions.get_mut(token) else {
            return;
        };
        if now >= session.absolute_deadline {
            return;
        }
        let idle = now.saturating_add(SESSION_IDLE_SECS);
        session.idle_deadline = idle.min(session.absolute_deadline);
    }

    /// WhoIs for a peer address, with a short success cache.
    pub fn lookup(&self, ip: IpAddr, now: i64) -> Result<TailnetIdentity, ()> {
        let ip = canonical_ip(ip);
        if let Some(hit) = self.cached(ip, now) {
            return Ok(hit);
        }
        let program = self.inner.program.clone();
        let output = command_output(&program, &["whois", "--json", &ip.to_string()]).ok_or(())?;
        let identity = parse_whois(&output).ok_or(())?;
        if let Ok(mut cache) = self.inner.whois_cache.lock() {
            cache.retain(|entry| now.saturating_sub(entry.at) < WHOIS_CACHE_SECS);
            cache.push(WhoisCache {
                ip,
                at: now,
                identity: identity.clone(),
            });
        }
        Ok(identity)
    }

    /// Ask Tailscale for addresses and a certificate. Does not bind a socket.
    pub fn prepare(&self) -> Result<PreparedTls, ()> {
        if !self.is_enabled() {
            return Err(());
        }
        self.set_phase(Phase::Starting, None, None);
        let program = self.inner.program.clone();
        let status = match command_output(&program, &["status", "--json"]) {
            Some(bytes) => bytes,
            None => return self.fail("Tailscale is not available on this computer."),
        };
        let Some(snapshot) = parse_status(&status) else {
            return self.fail("Tailscale is not available on this computer.");
        };
        if !snapshot.backend_running {
            return self.fail("Tailscale is not running.");
        }
        if !snapshot.online || snapshot.dns_name.is_empty() {
            return self.fail("This computer has no MagicDNS name.");
        }
        if snapshot.ips.is_empty() {
            return self.fail("This computer has no Tailscale address.");
        }
        let serve = match command_output(&program, &["serve", "status"]) {
            Some(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            None => return self.fail("Tailscale Serve status could not be read."),
        };
        if serve_blocks_remote(&serve, self.inner.port) {
            return self
                .fail("Tailscale Serve or Funnel is aimed at Maia, so phone access stays off.");
        }
        let config = match self.certificate(&program, &snapshot.dns_name) {
            Ok(config) => config,
            Err(reason) => return self.fail(reason),
        };
        Ok(PreparedTls {
            config,
            dns_name: snapshot.dns_name,
            ips: snapshot.ips,
        })
    }

    /// Remember the listener names and the URL the phone should open.
    pub fn set_ready(&self, dns_name: &str, ips: &[IpAddr]) {
        if let Ok(mut bound) = self.inner.bound.lock() {
            *bound = Some(BoundNames {
                dns_name: dns_name.to_owned(),
                ips: ips.to_vec(),
            });
        }
        let url = format!("https://{dns_name}:{}/", self.inner.port);
        self.set_phase(Phase::Ready, Some(url), None);
    }

    /// Record a fixed unavailable sentence.
    pub fn set_unavailable(&self, reason: &'static str) {
        self.set_phase(Phase::Unavailable, None, Some(reason.to_owned()));
    }

    /// Host allowlist for the current listener. Empty until it is ready.
    pub fn host_names(&self) -> Option<OwnedNames> {
        let bound = self.inner.bound.lock().ok()?;
        let bound = bound.as_ref()?;
        Some(OwnedNames {
            dns_name: bound.dns_name.clone(),
            port: self.inner.port,
            ips: bound.ips.clone(),
        })
    }

    /// Cookie header value for one session token.
    pub fn cookie_header(token: &str, max_age: i64) -> String {
        format!(
            "{COOKIE_NAME}={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={max_age}"
        )
    }

    /// Cookie name the middleware reads.
    pub fn cookie_name() -> &'static str {
        COOKIE_NAME
    }

    fn issue_session(&self, identity: &TailnetIdentity, now: i64) -> SessionIssued {
        let Some(token_bytes) = random_bytes::<32>() else {
            return SessionIssued::Denied;
        };
        let Some(csrf_bytes) = random_bytes::<32>() else {
            return SessionIssued::Denied;
        };
        let token = hex(&token_bytes);
        let csrf = hex(&csrf_bytes);
        let absolute = now.saturating_add(SESSION_ABSOLUTE_SECS);
        let idle = now.saturating_add(SESSION_IDLE_SECS).min(absolute);
        let Some(mut sessions) = self.inner.sessions.lock().ok() else {
            return SessionIssued::Denied;
        };
        sessions.insert(
            token.clone(),
            LiveSession {
                user_id: identity.user_id.clone(),
                node_id: identity.node_id.clone(),
                csrf: csrf.clone(),
                idle_deadline: idle,
                absolute_deadline: absolute,
            },
        );
        SessionIssued::Connected {
            token,
            csrf,
            max_age: SESSION_ABSOLUTE_SECS,
        }
    }

    fn certificate(
        &self,
        program: &str,
        dns_name: &str,
    ) -> Result<std::sync::Arc<rustls::ServerConfig>, &'static str> {
        if fs::create_dir_all(&self.inner.cert_dir).is_err() {
            return Err("A Tailscale certificate is not available.");
        }
        let cert = self.inner.cert_dir.join("cert.pem");
        let key = self.inner.cert_dir.join("key.pem");
        let cert_text = cert.to_string_lossy().into_owned();
        let key_text = key.to_string_lossy().into_owned();
        let output = Command::new(program)
            .args([
                "cert",
                "--cert-file",
                &cert_text,
                "--key-file",
                &key_text,
                dns_name,
            ])
            .output();
        let Ok(output) = output else {
            return Err("A Tailscale certificate is not available.");
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(certificate_failure_reason(&stderr));
        }
        load_server_config(&cert, &key).ok_or("A Tailscale certificate is not available.")
    }

    fn cached(&self, ip: IpAddr, now: i64) -> Option<TailnetIdentity> {
        let cache = self.inner.whois_cache.lock().ok()?;
        cache.iter().find_map(|entry| {
            (entry.ip == ip && now.saturating_sub(entry.at) < WHOIS_CACHE_SECS)
                .then(|| entry.identity.clone())
        })
    }

    fn allow_attempt(&self, node_id: &str, now: i64) -> bool {
        let Ok(failures) = self.inner.failures.lock() else {
            return false;
        };
        let Some(window) = failures.get(node_id) else {
            return true;
        };
        failures_allow(window.count, window.start, now)
    }

    fn note_failure(&self, node_id: &str, now: i64) {
        let Some(mut failures) = self.inner.failures.lock().ok() else {
            return;
        };
        let window = failures.entry(node_id.to_owned()).or_insert(FailWindow {
            start: now,
            count: 0,
        });
        if now.saturating_sub(window.start) >= super::admit::PAIR_WINDOW_SECS {
            window.start = now;
            window.count = 1;
            return;
        }
        window.count = window.count.saturating_add(1);
    }

    fn clear_failures(&self, node_id: &str) {
        if let Ok(mut failures) = self.inner.failures.lock() {
            failures.remove(node_id);
        }
    }

    fn store(&self, file: &PhoneFile) -> bool {
        store_file(&self.inner.path, file)
    }

    fn corrupt(&self) -> bool {
        self.inner.corrupt.lock().ok().is_some_and(|flag| *flag)
    }

    fn fail(&self, reason: &'static str) -> Result<PreparedTls, ()> {
        self.set_unavailable(reason);
        Err(())
    }

    fn set_phase(&self, phase: Phase, url: Option<String>, reason: Option<String>) {
        if let Ok(mut report) = self.inner.report.lock() {
            report.phase = phase;
            report.url = url;
            report.reason = reason;
        }
    }
}

/// What an already-identified phone is allowed to see.
pub enum PhoneState {
    /// Needs the pairing code.
    Unpaired { node_name: String },
    /// Tagged or anonymous.
    Denied,
    /// Paired owner client.
    Paired {
        url: Option<String>,
        devices: Vec<DeviceView>,
    },
}

impl PhoneFile {
    fn disabled() -> Self {
        Self {
            enabled: false,
            paired: Vec::new(),
            code_hash: None,
            code_expires_unix: None,
        }
    }

    fn code_is_active(&self, now: i64) -> bool {
        self.code_hash.is_some() && self.code_expires_unix.is_some_and(|expires| now < expires)
    }

    fn is_paired(&self, user_id: &str, node_id: &str) -> bool {
        self.paired
            .iter()
            .any(|device| device.user_id == user_id && device.node_id == node_id)
    }

    fn devices(&self) -> Vec<DeviceView> {
        self.paired
            .iter()
            .map(|device| DeviceView {
                node_id: device.node_id.clone(),
                name: device.name.clone(),
                paired_at: device.paired_at,
            })
            .collect()
    }
}

impl DesktopStatus {
    fn unavailable(reason: &str) -> Self {
        Self {
            enabled: false,
            phase: "unavailable",
            url: None,
            reason: Some(reason.to_owned()),
            code_active: false,
            devices: Vec::new(),
        }
    }
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Unavailable => "unavailable",
        }
    }
}

enum Load {
    Missing,
    Ready(PhoneFile),
    Corrupt,
}

fn load_file(path: &Path) -> Load {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Load::Missing,
        Err(_) => return Load::Corrupt,
    };
    match serde_json::from_slice(&bytes) {
        Ok(file) => Load::Ready(file),
        Err(_) => Load::Corrupt,
    }
}

fn store_file(path: &Path, file: &PhoneFile) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if fs::create_dir_all(parent).is_err() {
        return false;
    }
    let Some(text) = serde_json::to_string(file).ok() else {
        return false;
    };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_err() {
        return false;
    }
    if fs::rename(&tmp, path).is_ok() {
        return true;
    }
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).is_ok()
}

fn command_output(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new(program).args(args).output().ok()?;
    output.status.success().then_some(output.stdout)
}

fn load_server_config(
    cert_path: &Path,
    key_path: &Path,
) -> Option<std::sync::Arc<rustls::ServerConfig>> {
    let cert_bytes = fs::read(cert_path).ok()?;
    let key_bytes = fs::read(key_path).ok()?;
    let mut cert_reader = std::io::Cursor::new(cert_bytes);
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let mut key_reader = std::io::Cursor::new(key_bytes);
    let key = rustls_pemfile::private_key(&mut key_reader).ok()??;
    if certs.is_empty() {
        return None;
    }
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .ok()?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Some(std::sync::Arc::new(config))
}

fn random_bytes<const N: usize>() -> Option<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(bytes)
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(HEX[usize::from(byte >> 4)]));
        text.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    text
}

fn decode_hex(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let mut out = [0; 32];
    let bytes = text.as_bytes();
    for (index, slot) in out.iter_mut().enumerate() {
        let high = hex_value(bytes[index * 2])?;
        let low = hex_value(bytes[index * 2 + 1])?;
        *slot = (high << 4) | low;
    }
    Some(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Unix seconds. The skin reads the clock; leaves take the number.
pub fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        .try_into()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::sync::atomic::Ordering;

    use super::*;

    fn temp_hub() -> (RemoteHub, PathBuf) {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("maia-phone-{}-{id}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let (hub, _rx) = RemoteHub::open(&dir, 4178);
        (hub, dir)
    }

    fn pixel() -> TailnetIdentity {
        TailnetIdentity {
            user_id: "user-1".to_owned(),
            node_id: "node-1".to_owned(),
            node_name: "Pixel".to_owned(),
            tags: Vec::new(),
        }
    }

    #[test]
    fn pairing_persists_and_a_wrong_code_does_not() {
        let (hub, dir) = temp_hub();
        assert!(matches!(hub.issue_code(1_000), IssuedCode::NotEnabled));
        assert!(matches!(
            hub.enable(false),
            EnableResult::NeedsAcknowledgement
        ));
        assert!(matches!(hub.enable(true), EnableResult::Started));
        let IssuedCode::Shown { code, expires_at } = hub.issue_code(1_000) else {
            panic!("code");
        };
        assert_eq!(expires_at, 1_600);
        assert!(matches!(
            hub.accept_pair(&pixel(), "ZZZZ-ZZZZ", 1_100),
            SessionIssued::InvalidCode
        ));
        let (again, _) = RemoteHub::open(&dir, 4178);
        assert!(matches!(
            again.accept_pair(&pixel(), &code, 1_100),
            SessionIssued::Connected { .. }
        ));
        let status = again.desktop_status(1_100);
        assert!(status.enabled);
        assert_eq!(status.devices.len(), 1);
        assert!(!status.code_active);
        assert!(again.unpair(UnpairActor::Desktop, "node-1"));
        assert!(again.desktop_status(1_100).devices.is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn expired_code_does_not_pair() {
        let (hub, dir) = temp_hub();
        assert!(matches!(hub.enable(true), EnableResult::Started));
        let IssuedCode::Shown { code, .. } = hub.issue_code(1_000) else {
            panic!("code");
        };
        assert!(matches!(
            hub.accept_pair(&pixel(), &code, 1_000 + CODE_TTL_SECS),
            SessionIssued::InvalidCode
        ));
        let _ = fs::remove_dir_all(dir);
    }
}
