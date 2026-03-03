/**
 * @fileoverview Tests for the Maia bash-like command parser.
 * @module __tests__/lib/shell/parser.test
 */
import { describe, it, expect } from "bun:test";
import { parseCommandLine } from "@/lib/shell/parser";

describe("parseCommandLine", () => {
  it("@brief parses simple commands into argv tokens", () => {
    const parsed = parseCommandLine("echo hello world", {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands).toHaveLength(1);
    expect(parsed.commands[0]!.argv).toEqual(["echo", "hello", "world"]);
  });

  it("@brief respects single and double quotes without including them in argv", () => {
    const parsed = parseCommandLine(`echo "hello world" 'and more'`, {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands[0]!.argv).toEqual([
      "echo",
      "hello world",
      "and more",
    ]);
  });

  it("@brief expands environment variables using $VAR and ${VAR} syntax", () => {
    const parsed = parseCommandLine("echo $FOO ${BAR} baz", {
      env: { FOO: "one", BAR: "two" },
      cwdLogical: "~",
    });

    expect(parsed.commands[0]!.argv).toEqual(["echo", "one", "two", "baz"]);
  });

  it("@brief keeps tilde paths as logical (~, ~/subdir) for later resolution", () => {
    const parsed = parseCommandLine("cd ~ && echo ~/notes", {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands[0]!.argv).toEqual(["cd", "~"]);
    expect(parsed.commands[1]!.argv).toEqual(["echo", "~/notes"]);
  });

  it("@brief parses redirection operators >, >>, < and associates them with the correct command", () => {
    const parsed = parseCommandLine("echo hi > out.txt", {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands[0]!.argv).toEqual(["echo", "hi"]);
    expect(parsed.commands[0]!.redirects).toEqual([
      { type: ">", target: "out.txt" },
    ]);
  });

  it("@brief parses simple pipes into a pipeline of commands", () => {
    const parsed = parseCommandLine("echo foo | cat", {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands[0]!.argv).toEqual(["echo", "foo"]);
    expect(parsed.commands[1]!.argv).toEqual(["cat"]);
  });

  it("@brief supports pipelines combined with redirection on the last command", () => {
    const parsed = parseCommandLine("echo foo | cat > out.txt", {
      env: {},
      cwdLogical: "~",
    });

    expect(parsed.commands).toHaveLength(2);
    expect(parsed.commands[0]!.argv).toEqual(["echo", "foo"]);
    expect(parsed.commands[1]!.argv).toEqual(["cat"]);
    expect(parsed.commands[1]!.redirects).toEqual([
      { type: ">", target: "out.txt" },
    ]);
  });
});

