/**
 * @fileoverview Tests for skill frontmatter parsing.
 * @module __tests__/lib/skills/parse
 */
import { describe, it, expect } from "bun:test";
import { parseSkillFrontmatter } from "@/lib/skills/parse";

describe("parseSkillFrontmatter", () => {
  it("parses valid frontmatter with name and description", () => {
    const raw = `---
name: commit-changes
description: Commits repository changes with conventional-commit titles.
---

# Body here
`;
    const result = parseSkillFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("commit-changes");
    expect(result!.description).toBe("Commits repository changes with conventional-commit titles.");
    expect(result!.body.trim()).toBe("# Body here");
  });

  it("trims name and description values", () => {
    const raw = `---
name:  my-skill  
description:  Short description.  
---

Body
`;
    const result = parseSkillFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("my-skill");
    expect(result!.description).toBe("Short description.");
  });

  it("returns null when frontmatter is missing", () => {
    const raw = `# No frontmatter
Just markdown.
`;
    expect(parseSkillFrontmatter(raw)).toBeNull();
  });

  it("returns null when frontmatter has no closing ---", () => {
    const raw = `---
name: x
description: y
`;
    expect(parseSkillFrontmatter(raw)).toBeNull();
  });

  it("returns null when name is missing", () => {
    const raw = `---
description: Only description
---

Body
`;
    expect(parseSkillFrontmatter(raw)).toBeNull();
  });

  it("returns null when description is missing", () => {
    const raw = `---
name: only-name
---

Body
`;
    expect(parseSkillFrontmatter(raw)).toBeNull();
  });

  it("treats first --- as start of frontmatter", () => {
    const raw = `---
name: a
description: b
---
Content
`;
    const result = parseSkillFrontmatter(raw);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Content");
  });
});
