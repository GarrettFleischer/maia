//! Persistent shell for the published bash tool.
//!
//! On Windows the process is PowerShell. The callable name stays `bash`.

use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::Sender;
use std::sync::mpsc::channel;
use std::thread;
use std::time::Duration;

/// Why a shell command did not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellError {
    /// The process could not be started or has exited.
    Unavailable(String),
    /// The command was written and no sentinel came back.
    Timeout,
}

impl std::fmt::Display for ShellError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(detail) => formatter.write_str(detail),
            Self::Timeout => formatter
                .write_str("The command ended with an unknown outcome and was not retried."),
        }
    }
}

impl std::error::Error for ShellError {}

/// One persistent shell session.
pub struct ShellSession {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    kind: &'static str,
}

impl ShellSession {
    /// Starts the platform shell.
    pub fn start() -> Result<Self, ShellError> {
        let (program, args, kind) = shell_launch();
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            ShellError::Unavailable(format!("The shell did not start: {error}"))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| ShellError::Unavailable("The shell has no input.".to_owned()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| ShellError::Unavailable("The shell has no output.".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| ShellError::Unavailable("The shell has no error output.".to_owned()))?;
        let (sender, lines) = channel();
        spawn_reader(stdout, sender.clone());
        spawn_reader(stderr, sender);
        let mut session = Self {
            child,
            stdin,
            lines,
            kind,
        };
        session.wait_for("MAIA_READY", Duration::from_secs(10))?;
        Ok(session)
    }

    /// Shell named in the tool description.
    pub fn kind(&self) -> &'static str {
        self.kind
    }

    /// Runs one command, or replaces the session when `restart` is set.
    pub fn run(
        &mut self,
        command: Option<&str>,
        restart: bool,
        timeout: Duration,
    ) -> Result<String, ShellError> {
        if restart {
            self.restart()?;
            return Ok(format!("The {} session restarted.", self.kind));
        }
        let Some(command) = command.map(str::trim).filter(|text| !text.is_empty()) else {
            return Err(ShellError::Unavailable(
                "bash requires a command, or restart true.".to_owned(),
            ));
        };
        let nonce = format!("MAIA_END_{}", self.child.id());
        let payload = if cfg!(windows) {
            format!("{command}\nWrite-Output '{nonce} '+$LASTEXITCODE\nMAIA_RUN\n")
        } else {
            format!("{command}\nprintf '%s %s\\n' '{nonce}' $?\nMAIA_RUN\n")
        };
        self.stdin.write_all(payload.as_bytes()).map_err(|error| {
            ShellError::Unavailable(format!("The shell did not accept the command: {error}"))
        })?;
        self.stdin.flush().map_err(|error| {
            ShellError::Unavailable(format!("The shell did not accept the command: {error}"))
        })?;
        let mut output = String::new();
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                let _ = self.child.kill();
                return Err(ShellError::Timeout);
            }
            let line = self.lines.recv_timeout(remaining).map_err(|_| {
                let _ = self.child.kill();
                ShellError::Timeout
            })?;
            if let Some(rest) = line.trim().strip_prefix(&nonce) {
                let _exit = rest.trim();
                return Ok(output);
            }
            if output.len() < 65_536 {
                output.push_str(&line);
                output.push('\n');
            }
        }
    }

    fn restart(&mut self) -> Result<(), ShellError> {
        let _ = self.child.kill();
        let _ = self.child.wait();
        *self = Self::start()?;
        Ok(())
    }

    fn wait_for(&mut self, marker: &str, timeout: Duration) -> Result<(), ShellError> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(ShellError::Unavailable(
                    "The shell did not become ready.".to_owned(),
                ));
            }
            let line = self.lines.recv_timeout(remaining).map_err(|_| {
                ShellError::Unavailable("The shell did not become ready.".to_owned())
            })?;
            if line.contains(marker) {
                return Ok(());
            }
        }
    }
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn shell_launch() -> (&'static str, Vec<&'static str>, &'static str) {
    if cfg!(windows) {
        (
            "powershell.exe",
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                POWERSHELL_LOOP,
            ],
            "PowerShell",
        )
    } else {
        (
            "bash",
            vec!["--noprofile", "--norc", "-c", BASH_LOOP],
            "bash",
        )
    }
}

const POWERSHELL_LOOP: &str = concat!(
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false\n",
    "Write-Output 'MAIA_READY'\n",
    "while ($true) {\n",
    "  $buf = New-Object System.Collections.Generic.List[string]\n",
    "  while ($true) {\n",
    "    $line = [Console]::In.ReadLine()\n",
    "    if ($null -eq $line) { exit 0 }\n",
    "    if ($line -eq 'MAIA_RUN') { break }\n",
    "    [void]$buf.Add($line)\n",
    "  }\n",
    "  $code = $buf -join \"`n\"\n",
    "  try { Invoke-Expression $code } catch { Write-Output ($_ | Out-String) }\n",
    "}\n",
);

const BASH_LOOP: &str = concat!(
    "printf '%s\\n' MAIA_READY\n",
    "while true; do\n",
    "  buf=''\n",
    "  while IFS= read -r line; do\n",
    "    if [ \"$line\" = \"MAIA_RUN\" ]; then break; fi\n",
    "    buf=\"$buf$line\"$'\\n'\n",
    "  done\n",
    "  eval \"$buf\"\n",
    "done\n",
);

fn spawn_reader<R>(reader: R, sender: Sender<String>)
where
    R: std::io::Read + Send + 'static,
{
    thread::spawn(move || {
        let lines = BufReader::new(reader).lines();
        for line in lines {
            match line {
                Ok(text) => {
                    if sender.send(text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_runs_one_command() {
        let mut shell = ShellSession::start().expect("shell");
        let command = if cfg!(windows) {
            "Write-Output 'maia-shell-ok'"
        } else {
            "printf '%s\\n' maia-shell-ok"
        };
        let output = shell
            .run(Some(command), false, Duration::from_secs(20))
            .expect("command");
        assert!(output.contains("maia-shell-ok"), "{output}");
    }
}
