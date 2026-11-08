//! Injection-safe command plans. Arguments stay separate argv elements.

use std::fmt;

use crate::PlatformKind;

const MAX_PATH_LEN: usize = 4096;
const MAX_ARGS: usize = 256;

const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "dash",
    "zsh",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    "sh.exe",
    "bash.exe",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
    "wscript",
    "wscript.exe",
    "cscript",
    "cscript.exe",
];

const CREDENTIAL_FILES: &[&str] = &[
    "cookies",
    "cookies-journal",
    "login data",
    "login data-journal",
    "web data",
    "web data-journal",
    "local state",
];

const SECRET_MARKERS: &[&str] = &[
    "PASSWORD",
    "SECRET",
    "TOKEN",
    "COOKIE",
    "CREDENTIAL",
    "AUTHORIZATION",
    "CHROME",
    "USER_DATA",
    "API_KEY",
    "PRIVATE_KEY",
];

/// Validated executable and argv. There is no shell command string and no environment value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPlan {
    program: String,
    arguments: Vec<String>,
}

impl CommandPlan {
    /// Absolute executable path.
    pub fn program(&self) -> &str {
        &self.program
    }

    /// Argument vector, not a joined command line.
    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }
}

/// Environment allow-list of names. Values are not stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvPlan {
    names: Vec<String>,
}

impl EnvPlan {
    /// Allowed variable names.
    pub fn names(&self) -> &[String] {
        &self.names
    }
}

/// Why a command plan was rejected. Variants carry no path or argument text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CommandPlanError {
    /// The executable was empty.
    EmptyExecutable,
    /// The executable was not a canonical absolute path.
    RelativeExecutable,
    /// A `..` segment was present.
    ParentSegment,
    /// A path contained an empty segment.
    EmptySegment,
    /// The path was not in canonical form.
    NotCanonical,
    /// UNC, `\\?\`, or another device path.
    UncOrDevice,
    /// A control character was present.
    ControlCharacter,
    /// The path or argument was longer than the plan limit.
    TooLong,
    /// Too many arguments.
    TooManyArguments,
    /// The executable is a shell.
    ShellExecutable,
    /// A path names a browser credential file.
    CredentialFile,
    /// An argument selects a browser profile or debugging port.
    BrowserProfileArgument,
}

impl fmt::Display for CommandPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("command plan rejected")
    }
}

impl std::error::Error for CommandPlanError {}

/// Why a child plan still named the Chrome profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChildPlanError {
    /// A program or argument is the profile directory or a path inside it.
    ChromeProfileIncluded,
    /// The profile path itself was not canonical, so exclusion could not be proved.
    ProfilePathNotCanonical,
}

impl fmt::Display for ChildPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("chrome profile boundary rejected")
    }
}

impl std::error::Error for ChildPlanError {}

/// Why an environment name was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EnvPlanError {
    /// The name was empty.
    EmptyName,
    /// The name was not an ASCII identifier.
    InvalidName,
    /// The name looks like a secret, token, or browser profile variable.
    SecretName,
}

impl fmt::Display for EnvPlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("environment plan rejected")
    }
}

impl std::error::Error for EnvPlanError {}

/// Build an argv plan. Shell executables and credential paths are rejected.
pub fn try_command_plan(
    platform: PlatformKind,
    executable: &str,
    args: &[&str],
) -> Result<CommandPlan, CommandPlanError> {
    if executable.is_empty() {
        return Err(CommandPlanError::EmptyExecutable);
    }
    validate_text(executable)?;
    if args.len() > MAX_ARGS {
        return Err(CommandPlanError::TooManyArguments);
    }
    let parts = canonical_components(platform, executable)?;
    if components_name_credential(&parts) {
        return Err(CommandPlanError::CredentialFile);
    }
    if is_shell(parts.last().map(String::as_str).unwrap_or("")) {
        return Err(CommandPlanError::ShellExecutable);
    }
    let mut arguments = Vec::with_capacity(args.len());
    for arg in args {
        validate_text(arg)?;
        if is_browser_profile_arg(arg) {
            return Err(CommandPlanError::BrowserProfileArgument);
        }
        if looks_like_path(platform, arg) {
            let arg_parts = canonical_components(platform, arg)?;
            if components_name_credential(&arg_parts) {
                return Err(CommandPlanError::CredentialFile);
            }
        } else if is_credential_name(arg) {
            return Err(CommandPlanError::CredentialFile);
        }
        arguments.push((*arg).to_string());
    }
    Ok(CommandPlan {
        program: executable.to_string(),
        arguments,
    })
}

/// Reject plans whose program or arguments sit inside the Chrome profile directory.
pub fn command_excludes_chrome_profile(
    plan: &CommandPlan,
    platform: PlatformKind,
    profile: &str,
) -> Result<(), ChildPlanError> {
    let profile_parts = canonical_components(platform, profile)
        .map_err(|_| ChildPlanError::ProfilePathNotCanonical)?;
    if path_is_inside(platform, &profile_parts, plan.program())
        || plan
            .arguments
            .iter()
            .any(|arg| path_is_inside(platform, &profile_parts, arg))
    {
        return Err(ChildPlanError::ChromeProfileIncluded);
    }
    Ok(())
}

/// Whether `path` is the profile directory or a descendant.
///
/// A path that is not canonical returns `Ok(false)` so ordinary argv text is not a profile.
/// An unusable profile path returns [`ChildPlanError::ProfilePathNotCanonical`].
pub fn path_lies_in_chrome_profile(
    platform: PlatformKind,
    path: &str,
    profile: &str,
) -> Result<bool, ChildPlanError> {
    let profile_parts = canonical_components(platform, profile)
        .map_err(|_| ChildPlanError::ProfilePathNotCanonical)?;
    Ok(path_is_inside(platform, &profile_parts, path))
}

/// Accept environment names only. Secret-shaped names are rejected and not echoed.
pub fn try_env_plan(names: &[&str]) -> Result<EnvPlan, EnvPlanError> {
    let mut stored = Vec::with_capacity(names.len());
    for name in names {
        if name.is_empty() {
            return Err(EnvPlanError::EmptyName);
        }
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(EnvPlanError::InvalidName);
        }
        let upper = name.to_ascii_uppercase();
        if SECRET_MARKERS.iter().any(|marker| upper.contains(marker)) {
            return Err(EnvPlanError::SecretName);
        }
        stored.push((*name).to_string());
    }
    Ok(EnvPlan { names: stored })
}

fn path_is_inside(platform: PlatformKind, profile: &[String], candidate: &str) -> bool {
    let Ok(parts) = canonical_components(platform, candidate) else {
        return false;
    };
    parts.len() >= profile.len()
        && parts
            .iter()
            .zip(profile)
            .all(|(part, root)| components_equal(platform, part, root))
}

fn components_equal(platform: PlatformKind, left: &str, right: &str) -> bool {
    match platform {
        PlatformKind::Windows => left.eq_ignore_ascii_case(right),
        PlatformKind::Linux | PlatformKind::MacOs => left == right,
    }
}

fn validate_text(text: &str) -> Result<(), CommandPlanError> {
    if text.len() > MAX_PATH_LEN {
        return Err(CommandPlanError::TooLong);
    }
    if text.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err(CommandPlanError::ControlCharacter);
    }
    Ok(())
}

fn looks_like_path(platform: PlatformKind, text: &str) -> bool {
    match platform {
        PlatformKind::Windows => {
            text.contains('\\')
                || (text.len() >= 2
                    && text.as_bytes()[0].is_ascii_alphabetic()
                    && text.as_bytes()[1] == b':')
        }
        PlatformKind::Linux | PlatformKind::MacOs => text.contains('/'),
    }
}

fn canonical_components(
    platform: PlatformKind,
    path: &str,
) -> Result<Vec<String>, CommandPlanError> {
    match platform {
        PlatformKind::Windows => canonical_windows(path),
        PlatformKind::Linux | PlatformKind::MacOs => canonical_posix(path),
    }
}

fn canonical_windows(path: &str) -> Result<Vec<String>, CommandPlanError> {
    if path.starts_with('\\') || path.starts_with("//") {
        return Err(CommandPlanError::UncOrDevice);
    }
    if path.contains('/') {
        return Err(CommandPlanError::NotCanonical);
    }
    let mut chars = path.chars();
    let Some(drive) = chars.next() else {
        return Err(CommandPlanError::EmptyExecutable);
    };
    if !drive.is_ascii_alphabetic() || chars.next() != Some(':') || !path[2..].starts_with('\\') {
        return Err(CommandPlanError::RelativeExecutable);
    }
    let mut parts = vec![path[..2].to_string()];
    for component in path[3..].split('\\') {
        push_component(&mut parts, component)?;
    }
    if parts.len() == 1 {
        return Err(CommandPlanError::NotCanonical);
    }
    Ok(parts)
}

fn canonical_posix(path: &str) -> Result<Vec<String>, CommandPlanError> {
    if path.contains('\\') || !path.starts_with('/') {
        return Err(CommandPlanError::RelativeExecutable);
    }
    let mut parts = Vec::new();
    for (index, component) in path.split('/').enumerate() {
        if component.is_empty() {
            if index == 0 {
                continue;
            }
            return Err(CommandPlanError::EmptySegment);
        }
        push_component(&mut parts, component)?;
    }
    if parts.is_empty() {
        return Err(CommandPlanError::RelativeExecutable);
    }
    Ok(parts)
}

fn push_component(parts: &mut Vec<String>, component: &str) -> Result<(), CommandPlanError> {
    if component.is_empty() {
        return Err(CommandPlanError::EmptySegment);
    }
    if component == ".." {
        return Err(CommandPlanError::ParentSegment);
    }
    if component == "." {
        return Err(CommandPlanError::NotCanonical);
    }
    parts.push(component.to_string());
    Ok(())
}

fn components_name_credential(parts: &[String]) -> bool {
    parts.iter().any(|part| is_credential_name(part))
}

fn is_credential_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    CREDENTIAL_FILES.contains(&lower.as_str())
}

fn is_shell(basename: &str) -> bool {
    let lower = basename.to_ascii_lowercase();
    SHELLS.contains(&lower.as_str())
}

fn is_browser_profile_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    lower.starts_with("--user-data-dir")
        || lower.starts_with("--remote-debugging-port")
        || lower.contains("user-data-dir")
}
