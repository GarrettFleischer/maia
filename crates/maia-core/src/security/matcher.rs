//! Typed allowlist matchers and OS-specific canonical paths.
//!
//! Matching compares structured fields. It does not search display text.
//! Path canonicalization is lexical: no filesystem or clock access.

use crate::agents::{AgentId, ThreadId};
use crate::security::types::CapabilityKind;

/// Operating system a command or file path belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformKind {
    /// Windows paths use a drive prefix and backslashes.
    Windows,
    /// Linux paths are case-sensitive POSIX paths.
    Linux,
    /// macOS paths use POSIX lexical form and stay distinct from Linux.
    MacOs,
}

/// Why a path cannot become a canonical absolute path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PathError {
    /// The input was empty.
    Empty,
    /// The input contained a NUL byte.
    InteriorNul,
    /// The path is not absolute for the platform.
    NotAbsolute,
    /// A `..` component would leave the root.
    EscapesRoot,
    /// UNC, device, or other non-local prefix.
    UnsupportedPrefix,
    /// A Windows component is reserved, streamed, or not a plain name.
    InvalidComponent,
}

/// Canonical absolute path tied to one platform.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CanonicalAbsolutePath {
    platform: PlatformKind,
    path: String,
}

impl CanonicalAbsolutePath {
    /// Platform this path was canonicalized for.
    pub fn platform(&self) -> PlatformKind {
        self.platform
    }

    /// Canonical path text.
    pub fn as_str(&self) -> &str {
        &self.path
    }
}

/// Lexical canonical absolute path for `platform`.
///
/// This leaf does not read the filesystem. It does not resolve symlinks,
/// existence, or the working directory. The daemon and tool skin must pass a
/// path that has already been normalized under the same platform policy.
/// Windows paths are ASCII-uppercased so equality does not depend on the
/// filesystem. Linux and macOS keep case and reject each other's platform tag.
pub fn canonical_absolute_path(
    platform: PlatformKind,
    raw: &str,
) -> Result<CanonicalAbsolutePath, PathError> {
    if raw.is_empty() {
        return Err(PathError::Empty);
    }
    if raw.chars().any(|character| character == '\0') {
        return Err(PathError::InteriorNul);
    }
    let path = match platform {
        PlatformKind::Windows => canonical_windows(raw)?,
        PlatformKind::Linux | PlatformKind::MacOs => canonical_posix(raw)?,
    };
    Ok(CanonicalAbsolutePath { platform, path })
}

fn canonical_windows(raw: &str) -> Result<String, PathError> {
    let normalized = raw.replace('/', "\\");
    let text = strip_windows_prefix(&normalized)?;
    if !is_drive_absolute(text) {
        return Err(PathError::NotAbsolute);
    }
    let mut pieces = text.split('\\');
    let Some(drive_prefix) = pieces.next() else {
        return Err(PathError::NotAbsolute);
    };
    let drive = drive_letter(drive_prefix)?;
    let mut stack = Vec::new();
    for component in pieces {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if stack.pop().is_none() {
                return Err(PathError::EscapesRoot);
            }
            continue;
        }
        if rejected_windows_component(component) {
            return Err(PathError::InvalidComponent);
        }
        stack.push(component.to_ascii_uppercase());
    }
    let mut path = String::new();
    path.push(drive.to_ascii_uppercase());
    path.push(':');
    path.push('\\');
    for (index, component) in stack.iter().enumerate() {
        if index > 0 {
            path.push('\\');
        }
        path.push_str(component);
    }
    Ok(path)
}

fn strip_windows_prefix(text: &str) -> Result<&str, PathError> {
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.to_ascii_uppercase().starts_with(r"UNC\") || !is_drive_absolute(rest) {
            return Err(PathError::UnsupportedPrefix);
        }
        return Ok(rest);
    }
    if text.starts_with(r"\\") {
        return Err(PathError::UnsupportedPrefix);
    }
    Ok(text)
}

fn is_drive_absolute(text: &str) -> bool {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    let Some(second) = chars.next() else {
        return false;
    };
    let Some(third) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic() && second == ':' && third == '\\'
}

fn drive_letter(prefix: &str) -> Result<char, PathError> {
    let mut chars = prefix.chars();
    let Some(drive) = chars.next() else {
        return Err(PathError::NotAbsolute);
    };
    if chars.next() != Some(':') || chars.next().is_some() || !drive.is_ascii_alphabetic() {
        return Err(PathError::NotAbsolute);
    }
    Ok(drive)
}

fn rejected_windows_component(component: &str) -> bool {
    if component.ends_with('.') || component.ends_with(' ') || component.contains(':') {
        return true;
    }
    let Some(stem) = component.split('.').next() else {
        return true;
    };
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || reserved_device_port(&upper)
}

fn reserved_device_port(upper: &str) -> bool {
    let Some(rest) = upper
        .strip_prefix("COM")
        .or_else(|| upper.strip_prefix("LPT"))
    else {
        return false;
    };
    matches!(rest, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
}

fn canonical_posix(raw: &str) -> Result<String, PathError> {
    if !raw.starts_with('/') {
        return Err(PathError::NotAbsolute);
    }
    if raw.starts_with("//") {
        return Err(PathError::UnsupportedPrefix);
    }
    let mut stack = Vec::new();
    for component in raw.split('/') {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            if stack.pop().is_none() {
                return Err(PathError::EscapesRoot);
            }
            continue;
        }
        stack.push(component);
    }
    if stack.is_empty() {
        return Ok("/".to_owned());
    }
    let mut path = String::new();
    for component in stack {
        path.push('/');
        path.push_str(component);
    }
    Ok(path)
}

/// Why a typed action field was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionFieldError {
    /// Scheme was empty or not ASCII letters.
    EmptyScheme,
    /// Host was empty or contained a separator.
    EmptyHost,
    /// Web path contained a dot segment, NUL, or was not rooted.
    InvalidWebPath,
    /// Secret name was empty or contained NUL.
    EmptySecretName,
}

/// Web action compared field by field.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WebAction {
    scheme: String,
    host: String,
    port: u16,
    path: String,
    query: String,
}

impl WebAction {
    /// Builds a web action from exact typed fields.
    pub fn new(
        scheme: &str,
        host: &str,
        port: u16,
        path: &str,
        query: &str,
    ) -> Result<Self, ActionFieldError> {
        Ok(Self {
            scheme: canonical_scheme(scheme)?,
            host: canonical_host(host)?,
            port,
            path: canonical_web_path(path)?,
            query: query.strip_prefix('?').unwrap_or(query).to_owned(),
        })
    }
}

fn canonical_scheme(scheme: &str) -> Result<String, ActionFieldError> {
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|character| character.is_ascii_alphabetic())
    {
        return Err(ActionFieldError::EmptyScheme);
    }
    Ok(scheme.to_ascii_lowercase())
}

fn canonical_host(host: &str) -> Result<String, ActionFieldError> {
    if host.is_empty()
        || host.contains('/')
        || host.contains('\\')
        || host.contains(' ')
        || host.contains('\0')
    {
        return Err(ActionFieldError::EmptyHost);
    }
    Ok(host.to_ascii_lowercase())
}

fn canonical_web_path(path: &str) -> Result<String, ActionFieldError> {
    if path.is_empty() {
        return Ok("/".to_owned());
    }
    if !path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(ActionFieldError::InvalidWebPath);
    }
    let segments: Vec<&str> = path.split('/').skip(1).collect();
    if segments
        .iter()
        .any(|segment| *segment == "." || *segment == "..")
    {
        return Err(ActionFieldError::InvalidWebPath);
    }
    if segments
        .iter()
        .take(segments.len().saturating_sub(1))
        .any(|segment| segment.is_empty())
    {
        return Err(ActionFieldError::InvalidWebPath);
    }
    Ok(path.to_owned())
}

/// Secret reference name. This type does not hold a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SecretName(String);

impl SecretName {
    /// Rejects an empty name or a name containing NUL.
    pub fn new(name: &str) -> Result<Self, ActionFieldError> {
        if name.is_empty() || name.contains('\0') {
            return Err(ActionFieldError::EmptySecretName);
        }
        Ok(Self(name.to_owned()))
    }

    /// Name text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Browser verb stored on an exact action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BrowserVerb {
    /// Navigate a tab.
    Navigate,
    /// Read page content.
    Read,
    /// Activate a locator.
    Click,
    /// Type into a locator.
    Type,
    /// Extract a locator.
    Extract,
}

/// Scheme, host, and port of a browser origin.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WebOrigin {
    scheme: String,
    host: String,
    port: u16,
}

/// Browser action compared by verb, origin, and locator.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BrowserAction {
    verb: BrowserVerb,
    origin: WebOrigin,
    locator: String,
}

impl BrowserAction {
    /// Builds a browser action. Scheme and host are canonicalized; the locator is exact.
    pub fn new(
        verb: BrowserVerb,
        scheme: &str,
        host: &str,
        port: u16,
        locator: &str,
    ) -> Result<Self, ActionFieldError> {
        if locator.contains('\0') {
            return Err(ActionFieldError::InvalidWebPath);
        }
        Ok(Self {
            verb,
            origin: WebOrigin {
                scheme: canonical_scheme(scheme)?,
                host: canonical_host(host)?,
                port,
            },
            locator: locator.to_owned(),
        })
    }
}

/// Thread verb stored on an exact action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ThreadVerb {
    /// Open a thread.
    Open,
    /// Post to a thread.
    Post,
}

/// Thread action compared by verb, thread, and peer agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ThreadAction {
    /// Open or post.
    pub verb: ThreadVerb,
    /// Target thread.
    pub thread: ThreadId,
    /// Peer agent named by the action.
    pub peer: AgentId,
}

/// Canonical action an allowlist entry matches.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum CanonicalAllowAction {
    /// Command spawn.
    Command {
        /// Canonical executable.
        executable: CanonicalAbsolutePath,
        /// Exact argument vector.
        args: Vec<String>,
    },
    /// Web destination.
    Web(WebAction),
    /// File path.
    File {
        /// Canonical absolute path.
        path: CanonicalAbsolutePath,
    },
    /// Secret reference by name.
    Secret {
        /// Secret name.
        name: SecretName,
    },
    /// Browser action.
    Browser(BrowserAction),
    /// Thread open or post.
    Thread(ThreadAction),
}

/// One matcher field the owner can broaden on purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MatcherField {
    /// Any web scheme.
    WebScheme,
    /// Any web host.
    WebHost,
    /// Any web port.
    WebPort,
    /// Any web path.
    WebPath,
    /// Any web query.
    WebQuery,
    /// Any executable on the entry platform.
    CommandExecutable,
    /// Any argument vector.
    CommandArgs,
    /// Any file path on the entry platform.
    FilePath,
    /// Any secret name.
    SecretName,
    /// Any browser verb.
    BrowserVerb,
    /// Any browser origin.
    BrowserOrigin,
    /// Any browser locator.
    BrowserLocator,
    /// Any thread verb.
    ThreadVerb,
    /// Any thread id.
    ThreadId,
    /// Any thread peer.
    ThreadPeer,
}

/// Exact value or an owner-broadened any-value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldMatch<T> {
    /// One concrete value.
    Exact(T),
    /// Every value of this field.
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandMatcher {
    platform: PlatformKind,
    executable: FieldMatch<CanonicalAbsolutePath>,
    args: FieldMatch<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WebMatcher {
    scheme: FieldMatch<String>,
    host: FieldMatch<String>,
    port: FieldMatch<u16>,
    path: FieldMatch<String>,
    query: FieldMatch<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileMatcher {
    platform: PlatformKind,
    path: FieldMatch<CanonicalAbsolutePath>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SecretMatcher {
    name: FieldMatch<SecretName>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserMatcher {
    verb: FieldMatch<BrowserVerb>,
    origin: FieldMatch<WebOrigin>,
    locator: FieldMatch<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThreadMatcher {
    verb: FieldMatch<ThreadVerb>,
    thread: FieldMatch<ThreadId>,
    peer: FieldMatch<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ActionMatcher {
    Command(CommandMatcher),
    Web(WebMatcher),
    File(FileMatcher),
    Secret(SecretMatcher),
    Browser(BrowserMatcher),
    Thread(ThreadMatcher),
}

pub(crate) fn exact_matcher(action: &CanonicalAllowAction) -> ActionMatcher {
    match action {
        CanonicalAllowAction::Command { executable, args } => {
            ActionMatcher::Command(CommandMatcher {
                platform: executable.platform(),
                executable: FieldMatch::Exact(executable.clone()),
                args: FieldMatch::Exact(args.clone()),
            })
        }
        CanonicalAllowAction::Web(action) => ActionMatcher::Web(WebMatcher {
            scheme: FieldMatch::Exact(action.scheme.clone()),
            host: FieldMatch::Exact(action.host.clone()),
            port: FieldMatch::Exact(action.port),
            path: FieldMatch::Exact(action.path.clone()),
            query: FieldMatch::Exact(action.query.clone()),
        }),
        CanonicalAllowAction::File { path } => ActionMatcher::File(FileMatcher {
            platform: path.platform(),
            path: FieldMatch::Exact(path.clone()),
        }),
        CanonicalAllowAction::Secret { name } => ActionMatcher::Secret(SecretMatcher {
            name: FieldMatch::Exact(name.clone()),
        }),
        CanonicalAllowAction::Browser(action) => ActionMatcher::Browser(BrowserMatcher {
            verb: FieldMatch::Exact(action.verb),
            origin: FieldMatch::Exact(action.origin.clone()),
            locator: FieldMatch::Exact(action.locator.clone()),
        }),
        CanonicalAllowAction::Thread(action) => ActionMatcher::Thread(ThreadMatcher {
            verb: FieldMatch::Exact(action.verb),
            thread: FieldMatch::Exact(action.thread),
            peer: FieldMatch::Exact(action.peer),
        }),
    }
}

pub(crate) fn broaden_field(matcher: ActionMatcher, field: MatcherField) -> Option<ActionMatcher> {
    match (matcher, field) {
        (ActionMatcher::Web(mut matcher), MatcherField::WebScheme) => {
            matcher.scheme = FieldMatch::Any;
            Some(ActionMatcher::Web(matcher))
        }
        (ActionMatcher::Web(mut matcher), MatcherField::WebHost) => {
            matcher.host = FieldMatch::Any;
            Some(ActionMatcher::Web(matcher))
        }
        (ActionMatcher::Web(mut matcher), MatcherField::WebPort) => {
            matcher.port = FieldMatch::Any;
            Some(ActionMatcher::Web(matcher))
        }
        (ActionMatcher::Web(mut matcher), MatcherField::WebPath) => {
            matcher.path = FieldMatch::Any;
            Some(ActionMatcher::Web(matcher))
        }
        (ActionMatcher::Web(mut matcher), MatcherField::WebQuery) => {
            matcher.query = FieldMatch::Any;
            Some(ActionMatcher::Web(matcher))
        }
        (ActionMatcher::Command(mut matcher), MatcherField::CommandExecutable) => {
            matcher.executable = FieldMatch::Any;
            Some(ActionMatcher::Command(matcher))
        }
        (ActionMatcher::Command(mut matcher), MatcherField::CommandArgs) => {
            matcher.args = FieldMatch::Any;
            Some(ActionMatcher::Command(matcher))
        }
        (ActionMatcher::File(mut matcher), MatcherField::FilePath) => {
            matcher.path = FieldMatch::Any;
            Some(ActionMatcher::File(matcher))
        }
        (ActionMatcher::Secret(mut matcher), MatcherField::SecretName) => {
            matcher.name = FieldMatch::Any;
            Some(ActionMatcher::Secret(matcher))
        }
        (ActionMatcher::Browser(mut matcher), MatcherField::BrowserVerb) => {
            matcher.verb = FieldMatch::Any;
            Some(ActionMatcher::Browser(matcher))
        }
        (ActionMatcher::Browser(mut matcher), MatcherField::BrowserOrigin) => {
            matcher.origin = FieldMatch::Any;
            Some(ActionMatcher::Browser(matcher))
        }
        (ActionMatcher::Browser(mut matcher), MatcherField::BrowserLocator) => {
            matcher.locator = FieldMatch::Any;
            Some(ActionMatcher::Browser(matcher))
        }
        (ActionMatcher::Thread(mut matcher), MatcherField::ThreadVerb) => {
            matcher.verb = FieldMatch::Any;
            Some(ActionMatcher::Thread(matcher))
        }
        (ActionMatcher::Thread(mut matcher), MatcherField::ThreadId) => {
            matcher.thread = FieldMatch::Any;
            Some(ActionMatcher::Thread(matcher))
        }
        (ActionMatcher::Thread(mut matcher), MatcherField::ThreadPeer) => {
            matcher.peer = FieldMatch::Any;
            Some(ActionMatcher::Thread(matcher))
        }
        (_, _) => None,
    }
}

pub(crate) fn capability_compatible(kind: CapabilityKind, matcher: &ActionMatcher) -> bool {
    match matcher {
        ActionMatcher::Command(_) => kind == CapabilityKind::ConsoleExec,
        ActionMatcher::Web(_) => matches!(
            kind,
            CapabilityKind::WebRead | CapabilityKind::WebWrite | CapabilityKind::NonPublicEgress
        ),
        ActionMatcher::File(_) => kind == CapabilityKind::VaultRead,
        ActionMatcher::Secret(_) => kind == CapabilityKind::SecretUse,
        ActionMatcher::Browser(_) => matches!(
            kind,
            CapabilityKind::WebCredentialed
                | CapabilityKind::WebRead
                | CapabilityKind::WebWrite
                | CapabilityKind::ContextEgress
        ),
        ActionMatcher::Thread(matcher) => match matcher.verb {
            FieldMatch::Exact(ThreadVerb::Open) => kind == CapabilityKind::OpenThread,
            FieldMatch::Exact(ThreadVerb::Post) => kind == CapabilityKind::PostMessage,
            FieldMatch::Any => matches!(
                kind,
                CapabilityKind::OpenThread | CapabilityKind::PostMessage
            ),
        },
    }
}

pub(crate) fn matcher_covers(matcher: &ActionMatcher, action: &CanonicalAllowAction) -> bool {
    match (matcher, action) {
        (ActionMatcher::Command(matcher), CanonicalAllowAction::Command { executable, args }) => {
            executable.platform() == matcher.platform
                && field_matches(&matcher.executable, executable)
                && field_matches(&matcher.args, args)
        }
        (ActionMatcher::Web(matcher), CanonicalAllowAction::Web(action)) => {
            field_matches(&matcher.scheme, &action.scheme)
                && field_matches(&matcher.host, &action.host)
                && field_matches(&matcher.port, &action.port)
                && field_matches(&matcher.path, &action.path)
                && field_matches(&matcher.query, &action.query)
        }
        (ActionMatcher::File(matcher), CanonicalAllowAction::File { path }) => {
            path.platform() == matcher.platform && field_matches(&matcher.path, path)
        }
        (ActionMatcher::Secret(matcher), CanonicalAllowAction::Secret { name }) => {
            field_matches(&matcher.name, name)
        }
        (ActionMatcher::Browser(matcher), CanonicalAllowAction::Browser(action)) => {
            field_matches(&matcher.verb, &action.verb)
                && field_matches(&matcher.origin, &action.origin)
                && field_matches(&matcher.locator, &action.locator)
        }
        (ActionMatcher::Thread(matcher), CanonicalAllowAction::Thread(action)) => {
            field_matches(&matcher.verb, &action.verb)
                && field_matches(&matcher.thread, &action.thread)
                && field_matches(&matcher.peer, &action.peer)
        }
        _ => false,
    }
}

fn field_matches<T: PartialEq>(field: &FieldMatch<T>, value: &T) -> bool {
    match field {
        FieldMatch::Any => true,
        FieldMatch::Exact(expected) => expected == value,
    }
}

/// Persisted command matcher. Restore checks platform agreement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandMatcherSnapshot {
    /// Operating system this command entry belongs to.
    pub platform: PlatformKind,
    /// Executable path, or any path on `platform`.
    pub executable: FieldMatch<CanonicalAbsolutePath>,
    /// Argument vector, or any arguments.
    pub args: FieldMatch<Vec<String>>,
}

/// Persisted web matcher. Exact strings must already be canonical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebMatcherSnapshot {
    /// Scheme.
    pub scheme: FieldMatch<String>,
    /// Host.
    pub host: FieldMatch<String>,
    /// Port.
    pub port: FieldMatch<u16>,
    /// Path.
    pub path: FieldMatch<String>,
    /// Query without a leading `?`.
    pub query: FieldMatch<String>,
}

/// Persisted file matcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMatcherSnapshot {
    /// Operating system for this path.
    pub platform: PlatformKind,
    /// Canonical path, or any path on `platform`.
    pub path: FieldMatch<CanonicalAbsolutePath>,
}

/// Persisted secret-name matcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretMatcherSnapshot {
    /// Secret reference name.
    pub name: FieldMatch<String>,
}

/// Browser origin stored on a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebOriginSnapshot {
    /// Canonical scheme.
    pub scheme: String,
    /// Canonical host.
    pub host: String,
    /// Port.
    pub port: u16,
}

/// Persisted browser matcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserMatcherSnapshot {
    /// Verb.
    pub verb: FieldMatch<BrowserVerb>,
    /// Origin.
    pub origin: FieldMatch<WebOriginSnapshot>,
    /// Locator text.
    pub locator: FieldMatch<String>,
}

/// Persisted thread matcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadMatcherSnapshot {
    /// Open or post, or any verb.
    pub verb: FieldMatch<ThreadVerb>,
    /// Thread id.
    pub thread: FieldMatch<ThreadId>,
    /// Peer agent.
    pub peer: FieldMatch<AgentId>,
}

/// Persisted typed matcher. This is not an admitted entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionMatcherSnapshot {
    /// Command matcher.
    Command(CommandMatcherSnapshot),
    /// Web matcher.
    Web(WebMatcherSnapshot),
    /// File matcher.
    File(FileMatcherSnapshot),
    /// Secret matcher.
    Secret(SecretMatcherSnapshot),
    /// Browser matcher.
    Browser(BrowserMatcherSnapshot),
    /// Thread matcher.
    Thread(ThreadMatcherSnapshot),
}

/// Why a matcher snapshot cannot become a validated matcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum MatcherRestoreError {
    /// A typed field failed validation.
    InvalidField(ActionFieldError),
    /// An exact field is not already in canonical form.
    NotCanonical,
    /// The matcher platform disagrees with the path platform.
    PlatformMismatch,
}

pub(crate) fn snapshot_matcher(matcher: &ActionMatcher) -> ActionMatcherSnapshot {
    match matcher {
        ActionMatcher::Command(matcher) => ActionMatcherSnapshot::Command(CommandMatcherSnapshot {
            platform: matcher.platform,
            executable: matcher.executable.clone(),
            args: matcher.args.clone(),
        }),
        ActionMatcher::Web(matcher) => ActionMatcherSnapshot::Web(WebMatcherSnapshot {
            scheme: matcher.scheme.clone(),
            host: matcher.host.clone(),
            port: matcher.port,
            path: matcher.path.clone(),
            query: matcher.query.clone(),
        }),
        ActionMatcher::File(matcher) => ActionMatcherSnapshot::File(FileMatcherSnapshot {
            platform: matcher.platform,
            path: matcher.path.clone(),
        }),
        ActionMatcher::Secret(matcher) => ActionMatcherSnapshot::Secret(SecretMatcherSnapshot {
            name: match &matcher.name {
                FieldMatch::Any => FieldMatch::Any,
                FieldMatch::Exact(name) => FieldMatch::Exact(name.as_str().to_owned()),
            },
        }),
        ActionMatcher::Browser(matcher) => ActionMatcherSnapshot::Browser(BrowserMatcherSnapshot {
            verb: matcher.verb,
            origin: match &matcher.origin {
                FieldMatch::Any => FieldMatch::Any,
                FieldMatch::Exact(origin) => FieldMatch::Exact(WebOriginSnapshot {
                    scheme: origin.scheme.clone(),
                    host: origin.host.clone(),
                    port: origin.port,
                }),
            },
            locator: matcher.locator.clone(),
        }),
        ActionMatcher::Thread(matcher) => ActionMatcherSnapshot::Thread(ThreadMatcherSnapshot {
            verb: matcher.verb,
            thread: matcher.thread,
            peer: matcher.peer,
        }),
    }
}

pub(crate) fn restore_matcher(
    snapshot: ActionMatcherSnapshot,
) -> Result<ActionMatcher, MatcherRestoreError> {
    match snapshot {
        ActionMatcherSnapshot::Command(matcher) => {
            if let FieldMatch::Exact(path) = &matcher.executable {
                if path.platform() != matcher.platform {
                    return Err(MatcherRestoreError::PlatformMismatch);
                }
            }
            Ok(ActionMatcher::Command(CommandMatcher {
                platform: matcher.platform,
                executable: matcher.executable,
                args: matcher.args,
            }))
        }
        ActionMatcherSnapshot::Web(matcher) => Ok(ActionMatcher::Web(WebMatcher {
            scheme: restore_canonical_text(matcher.scheme, canonical_scheme)?,
            host: restore_canonical_text(matcher.host, canonical_host)?,
            port: matcher.port,
            path: restore_canonical_text(matcher.path, canonical_web_path)?,
            query: restore_canonical_text(matcher.query, canonical_query)?,
        })),
        ActionMatcherSnapshot::File(matcher) => {
            if let FieldMatch::Exact(path) = &matcher.path {
                if path.platform() != matcher.platform {
                    return Err(MatcherRestoreError::PlatformMismatch);
                }
            }
            Ok(ActionMatcher::File(FileMatcher {
                platform: matcher.platform,
                path: matcher.path,
            }))
        }
        ActionMatcherSnapshot::Secret(matcher) => Ok(ActionMatcher::Secret(SecretMatcher {
            name: match matcher.name {
                FieldMatch::Any => FieldMatch::Any,
                FieldMatch::Exact(raw) => {
                    let name = SecretName::new(&raw).map_err(MatcherRestoreError::InvalidField)?;
                    if name.as_str() != raw {
                        return Err(MatcherRestoreError::NotCanonical);
                    }
                    FieldMatch::Exact(name)
                }
            },
        })),
        ActionMatcherSnapshot::Browser(matcher) => {
            let locator = match matcher.locator {
                FieldMatch::Any => FieldMatch::Any,
                FieldMatch::Exact(raw) => {
                    if raw.contains('\0') {
                        return Err(MatcherRestoreError::InvalidField(
                            ActionFieldError::InvalidWebPath,
                        ));
                    }
                    FieldMatch::Exact(raw)
                }
            };
            let origin = match matcher.origin {
                FieldMatch::Any => FieldMatch::Any,
                FieldMatch::Exact(raw) => {
                    let scheme =
                        canonical_scheme(&raw.scheme).map_err(MatcherRestoreError::InvalidField)?;
                    let host =
                        canonical_host(&raw.host).map_err(MatcherRestoreError::InvalidField)?;
                    if scheme != raw.scheme || host != raw.host {
                        return Err(MatcherRestoreError::NotCanonical);
                    }
                    FieldMatch::Exact(WebOrigin {
                        scheme,
                        host,
                        port: raw.port,
                    })
                }
            };
            Ok(ActionMatcher::Browser(BrowserMatcher {
                verb: matcher.verb,
                origin,
                locator,
            }))
        }
        ActionMatcherSnapshot::Thread(matcher) => Ok(ActionMatcher::Thread(ThreadMatcher {
            verb: matcher.verb,
            thread: matcher.thread,
            peer: matcher.peer,
        })),
    }
}

fn restore_canonical_text(
    field: FieldMatch<String>,
    canonicalize: fn(&str) -> Result<String, ActionFieldError>,
) -> Result<FieldMatch<String>, MatcherRestoreError> {
    match field {
        FieldMatch::Any => Ok(FieldMatch::Any),
        FieldMatch::Exact(raw) => {
            let canonical = canonicalize(&raw).map_err(MatcherRestoreError::InvalidField)?;
            if canonical != raw {
                return Err(MatcherRestoreError::NotCanonical);
            }
            Ok(FieldMatch::Exact(canonical))
        }
    }
}

/// Stored queries have no leading `?`. A prefix makes the result differ so restore rejects it.
fn canonical_query(query: &str) -> Result<String, ActionFieldError> {
    if query.contains('\0') {
        return Err(ActionFieldError::InvalidWebPath);
    }
    if let Some(stripped) = query.strip_prefix('?') {
        return Ok(stripped.to_owned());
    }
    Ok(query.to_owned())
}
