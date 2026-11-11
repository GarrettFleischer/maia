//! `maia-daemon brain export|import|sync` parsed before provider settings load.

use std::path::PathBuf;

/// Which Markdown operation the process should run instead of serving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrainVerb {
    /// Write the database out as Markdown.
    Export,
    /// Load Markdown into an empty database.
    Import,
    /// Apply newer Markdown edits.
    Sync,
}

/// One parsed brain command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrainCli {
    /// Export, import, or sync.
    pub verb: BrainVerb,
    /// Folder of Markdown neurons. Defaults to `data/brain-md`.
    pub directory: PathBuf,
}

/// Parses argv when it starts with `brain`. `None` means start the server.
///
/// `args[0]` is the executable name.
pub fn parse_brain_args(args: &[String]) -> Option<Result<BrainCli, String>> {
    if args.get(1).map(String::as_str) != Some("brain") {
        return None;
    }
    let verb = match args.get(2).map(String::as_str) {
        Some("export") => BrainVerb::Export,
        Some("import") => BrainVerb::Import,
        Some("sync") => BrainVerb::Sync,
        _ => {
            return Some(Err(
                "usage: maia-daemon brain export|import|sync [--dir path]".to_owned(),
            ));
        }
    };
    let mut directory = PathBuf::from("data").join("brain-md");
    let mut index = 3;
    while index < args.len() {
        if args[index] != "--dir" {
            return Some(Err(
                "usage: maia-daemon brain export|import|sync [--dir path]".to_owned(),
            ));
        }
        let Some(path) = args.get(index + 1) else {
            return Some(Err("brain --dir needs a folder".to_owned()));
        };
        if path.is_empty() {
            return Some(Err("brain --dir needs a folder".to_owned()));
        }
        directory = PathBuf::from(path);
        index += 2;
    }
    Some(Ok(BrainCli { verb, directory }))
}

#[cfg(test)]
mod tests {
    use super::BrainVerb;
    use super::parse_brain_args;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_owned()).collect()
    }

    #[test]
    fn server_args_are_not_a_brain_command() {
        assert!(parse_brain_args(&args(&["maia-daemon"])).is_none());
    }

    #[test]
    fn export_defaults_the_directory_and_import_reads_dir() {
        let export = parse_brain_args(&args(&["maia-daemon", "brain", "export"]))
            .expect("command")
            .expect("parsed");
        assert_eq!(export.verb, BrainVerb::Export);
        assert_eq!(export.directory, std::path::PathBuf::from("data").join("brain-md"));
        let import = parse_brain_args(&args(&[
            "maia-daemon",
            "brain",
            "import",
            "--dir",
            "notes",
        ]))
        .expect("command")
        .expect("parsed");
        assert_eq!(import.verb, BrainVerb::Import);
        assert_eq!(import.directory, std::path::PathBuf::from("notes"));
    }

    #[test]
    fn unknown_verb_is_a_usage_error() {
        let error = parse_brain_args(&args(&["maia-daemon", "brain", "dream"]))
            .expect("command")
            .expect_err("usage");
        assert!(error.contains("export|import|sync"));
    }
}
