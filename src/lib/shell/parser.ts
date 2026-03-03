/**
 * @fileoverview Bash-like command line parser for the Maia shell.
 * Tokenizes input, handles basic quoting and environment variable expansion,
 * and produces a simple pipeline representation for the execution engine.
 * @module lib/shell/parser
 */

export type RedirectType = ">" | ">>" | "<";

export interface Redirect {
  /** Redirection operator type. */
  type: RedirectType;
  /** Target path or descriptor token following the operator. */
  target: string;
}

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
  const tokens = tokenize(input, options.env);
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
    if (tok === ">" || tok === ">>" || tok === "<") {
      const target = tokens[i + 1];
      if (target == null) break;
      current.redirects.push({ type: tok as RedirectType, target });
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
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_") {
      name += ch;
      i += 1;
      continue;
    }
    break;
  }
  const value = name.length > 0 ? env[name] ?? "" : "$";
  return { value, nextIndex: i };
}

