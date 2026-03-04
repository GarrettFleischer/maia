/**
 * @fileoverview Bash-like command line parser for the Maia shell.
 * Tokenizes input, handles basic quoting and environment variable expansion,
 * and produces a simple pipeline representation for the execution engine.
 * @module lib/shell/parser
 */

export type RedirectType = ">" | ">>" | "<" | "heredoc";

/** File redirection: >, >>, <. */
export interface FileRedirect {
  type: ">" | ">>" | "<";
  /** Target path following the operator. */
  target: string;
}

/** Heredoc redirection: <<'DELIM' or <<DELIM with body up to line DELIM. */
export interface HeredocRedirect {
  type: "heredoc";
  /** Delimiter word (e.g. "EOF"). */
  delimiter: string;
  /** Literal body from the line after the delimiter line through the line before the closing delimiter. */
  body: string;
}

export type Redirect = FileRedirect | HeredocRedirect;

export interface ParsedCommand {
  /** Argument vector for the command (argv[0] is the program name). */
  argv: string[];
  /** Redirection directives associated with this command. */
  redirects: Redirect[];
}

export interface ParsedPipeline {
  /** Ordered list of commands participating in the pipeline. */
  commands: ParsedCommand[];
}

export interface ParseOptions {
  /**
   * Environment variables available for expansion via $VAR and ${VAR}.
   */
  env: Record<string, string>;
  /**
   * Logical current working directory (e.g. "~", "~/subdir").
   * Reserved for future relative-path behavior.
   */
  cwdLogical: string;
}

const HEREDOC_PLACEHOLDER_PREFIX = "\u0000HEREDOC";
const HEREDOC_PLACEHOLDER_SUFFIX = "\u0000";

function isHeredocPlaceholder(token: string): token is string {
  return (
    token.startsWith(HEREDOC_PLACEHOLDER_PREFIX) &&
    token.endsWith(HEREDOC_PLACEHOLDER_SUFFIX)
  );
}

function heredocPlaceholderIndex(token: string): number {
  const inner = token.slice(
    HEREDOC_PLACEHOLDER_PREFIX.length,
    token.length - HEREDOC_PLACEHOLDER_SUFFIX.length,
  );
  const n = parseInt(inner, 10);
  return Number.isNaN(n) ? -1 : n;
}

/**
 * @brief Extract heredoc regions (<<'DELIM' or <<DELIM ... DELIM) from input.
 * Replaces each heredoc with a placeholder so tokenizer sees a single token.
 * @param input Raw command line string.
 * @returns Modified input and list of { delimiter, body } for each heredoc.
 */
function extractHeredocs(input: string): {
  input: string;
  heredocs: { delimiter: string; body: string }[];
} {
  const heredocs: { delimiter: string; body: string }[] = [];
  let result = input;
  let i = 0;
  while (i < result.length) {
    if (result[i] === "'") {
      i += 1;
      while (i < result.length && result[i] !== "'") i += 1;
      if (i < result.length) i += 1;
      continue;
    }
    if (result.slice(i, i + 2) === "<<") {
      const heredocStart = i;
      i += 2;
      let delimiter: string;
      let bodyStart: number;
      if (result[i] === "'") {
        i += 1;
        const delimStart = i;
        while (i < result.length && result[i] !== "'") i += 1;
        delimiter = result.slice(delimStart, i);
        if (i < result.length) i += 1;
        const nl = result.indexOf("\n", i);
        bodyStart = nl === -1 ? result.length : nl + 1;
      } else {
        const delimStart = i;
        while (
          i < result.length &&
          result[i] !== " " &&
          result[i] !== "\t" &&
          result[i] !== "\n"
        )
          i += 1;
        delimiter = result.slice(delimStart, i).trim();
        while (i < result.length && (result[i] === " " || result[i] === "\t"))
          i += 1;
        if (result[i] === "\n") i += 1;
        bodyStart = i;
      }
      const fromBody = result.slice(bodyStart);
      const lines = fromBody.split("\n");
      let j = 0;
      for (; j < lines.length; j++) {
        if (lines[j] === delimiter) break;
      }
      if (j >= lines.length) {
        i = heredocStart + 1;
        continue;
      }
      const bodyLines = lines.slice(0, j);
      const body = bodyLines.length > 0 ? bodyLines.join("\n") + "\n" : "";
      const bodyLength = body.length;
      const endOfHeredoc = bodyStart + bodyLength + delimiter.length + 1;
      const placeholder = `${HEREDOC_PLACEHOLDER_PREFIX}${heredocs.length}${HEREDOC_PLACEHOLDER_SUFFIX}`;
      heredocs.push({ delimiter, body });
      result =
        result.slice(0, heredocStart) +
        " " +
        placeholder +
        " " +
        result.slice(endOfHeredoc);
      i = heredocStart + placeholder.length + 2;
    } else {
      i += 1;
    }
  }
  return { input: result, heredocs };
}

/**
 * @brief Parse a bash-like command line into a pipeline of commands.
 * @param input Raw command line string.
 * @param options Parsing options including environment and cwd.
 * @returns ParsedPipeline describing commands, argv, and redirections.
 */
export function parseCommandLine(
  input: string,
  options: ParseOptions,
): ParsedPipeline {
  const { input: input2, heredocs } = extractHeredocs(input);
  const tokens = tokenize(input2, options.env);
  const commands: ParsedCommand[] = [];

  let current: ParsedCommand = { argv: [], redirects: [] };
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "|") {
      commands.push(current);
      current = { argv: [], redirects: [] };
      i += 1;
      continue;
    }
    if (isHeredocPlaceholder(tok)) {
      const idx = heredocPlaceholderIndex(tok);
      if (idx >= 0 && idx < heredocs.length) {
        const { delimiter, body } = heredocs[idx]!;
        current.redirects.push({ type: "heredoc", delimiter, body });
      }
      i += 1;
      continue;
    }
    if (tok === ">" || tok === ">>" || tok === "<") {
      const target = tokens[i + 1];
      if (target == null) break;
      current.redirects.push({ type: tok as FileRedirect["type"], target });
      i += 2;
      continue;
    }
    if (tok === "&&") {
      // Simple command chaining: treat as a boundary and start a new command.
      commands.push(current);
      current = { argv: [], redirects: [] };
      i += 1;
      continue;
    }
    current.argv.push(tok);
    i += 1;
  }
  if (current.argv.length > 0 || current.redirects.length > 0) {
    commands.push(current);
  }

  return { commands };
}

/**
 * @brief Tokenize a shell command line, applying basic quoting and environment
 * variable expansion. Tilde paths (~, ~/...) are preserved as-is for later
 * resolution by the filesystem layer.
 * @param input Raw command line string.
 * @param env Environment variables for expansion.
 * @returns Array of tokens including words and operators (|, >, >>, <, &&).
 */
function tokenize(input: string, env: Record<string, string>): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };

  while (i < input.length) {
    const ch = input[i]!;

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t") {
      flush();
      i += 1;
      continue;
    }

    if (ch === "&" && input[i + 1] === "&") {
      flush();
      tokens.push("&&");
      i += 2;
      continue;
    }

    if (ch === "|" || ch === "<") {
      flush();
      tokens.push(ch);
      i += 1;
      continue;
    }

    if (ch === ">") {
      flush();
      if (input[i + 1] === ">") {
        tokens.push(">>");
        i += 2;
      } else {
        tokens.push(">");
        i += 1;
      }
      continue;
    }

    if (ch === "$") {
      const { value, nextIndex } = expandEnv(input, i, env);
      current += value;
      i = nextIndex;
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return tokens;
}

/**
 * @brief Expand an environment variable starting at the given index.
 * Supports $VAR and ${VAR} syntax. When the variable is undefined,
 * expands to the empty string.
 * @param input Full command line input.
 * @param startIndex Index of the '$' character.
 * @param env Environment variables map.
 * @returns Expanded value and the next index to continue scanning from.
 */
function expandEnv(
  input: string,
  startIndex: number,
  env: Record<string, string>,
): { value: string; nextIndex: number } {
  let i = startIndex + 1;
  if (input[i] === "{") {
    i += 1;
    let name = "";
    while (i < input.length && input[i] !== "}") {
      name += input[i];
      i += 1;
    }
    if (i < input.length && input[i] === "}") {
      i += 1;
    }
    const value = env[name] ?? "";
    return { value, nextIndex: i };
  }

  let name = "";
  while (i < input.length) {
    const ch = input[i]!;
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_"
    ) {
      name += ch;
      i += 1;
      continue;
    }
    break;
  }
  const value = name.length > 0 ? (env[name] ?? "") : "$";
  return { value, nextIndex: i };
}
