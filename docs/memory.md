# Memory System

Maia uses a four-tier memory system with an immutable audit trail, a curated markdown file, a searchable vector database, and a human-readable Obsidian knowledge graph.

## Memory Tiers Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Tier 1: Daily Logs (Immutable Audit Trail)                  │
│   memory/YYYY-MM-DD.md -- append-only, never deleted        │
│   Raw record of everything that happened each day           │
└─────────────────────┬───────────────────────────────────────┘
                      │ End-of-day consolidation
                      ▼
┌─────────────────────────────────────────────────────────────┐
│ Tier 2: MEMORY.md (Agent-Curated Quick Reference)           │
│   Freeform markdown maintained by the agent                 │
│   Distilled insights, ongoing context, key notes            │
├─────────────────────────────────────────────────────────────┤
│ Tier 3: Vector Database (Searchable Source of Truth)        │
│   SQLite + embeddings + FTS5 hybrid search                  │
│   Structured, categorized, importance-scored entries         │
├─────────────────────────────────────────────────────────────┤
│ Tier 4: Knowledge Vault (Human-Readable Graph)              │
│   knowledge/ -- Obsidian-compatible [[wikilinked]] notes    │
│   Interconnected notes about people, projects, topics       │
└─────────────────────────────────────────────────────────────┘
```

## Tier 1: Daily Logs

**Location**: `~/.maia/workspace/memory/YYYY-MM-DD.md`

Daily log files are the raw, immutable audit trail of every interaction.

### Rules

- **One file per day**, named by date (e.g., `2026-02-13.md`)
- **Append-only**: content is only ever added, never modified or deleted
- **Complete record**: decisions, context, tasks completed, notable conversations
- **Session startup**: today + yesterday are read for recent context
- **Retention**: files remain on disk indefinitely

### Format

```markdown
# 2026-02-13

## Session 10:30 AM
- User asked about PostgreSQL indexing strategies
- Recommended B-tree for primary keys, GIN for full-text search
- User is working on the [[Maia Project]] database layer

## Session 2:15 PM
- Discussed TypeScript patterns for dependency injection
- User prefers constructor injection over property injection
- Stored preference: "TypeScript: constructor DI > property DI"
```

### Secret Scanning

Before any content is appended to a daily log, the secret scanner checks for accidentally captured credentials. If detected, the content is redacted and an audit event is logged.

## Tier 2: MEMORY.md

**Location**: `~/.maia/workspace/MEMORY.md`

The agent's own curated long-term notes in freeform markdown.

### Characteristics

- **Agent-maintained**: the agent reads, edits, and updates this file as it learns
- **Quick reference**: distilled wisdom, ongoing context, important notes
- **Main sessions only**: loaded in private sessions, never in group contexts (security)
- **Periodically reviewed**: updated during consolidation, outdated info removed

### Example

```markdown
# Memory

## About Garrett
- Prefers dark mode in all applications
- Working on the Maia AI assistant project
- Timezone: EST
- Pronouns: he/him

## Active Projects
- **Maia**: TypeScript/Bun AI assistant with four-tier memory
- **Website Redesign**: Using Next.js + Tailwind

## Key Decisions
- Using SQLite with FTS5 for memory search (decided 2026-02-10)
- Bun as the runtime instead of Node.js
- Constructor-based dependency injection

## Preferences
- TypeScript over JavaScript
- Explicit types over inference for function signatures
- Comprehensive doc comments on all functions
```

## Tier 3: Vector Database

**Location**: `~/.maia/data/memory.sqlite`

The primary searchable source of truth for structured memory.

### Schema

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('preference','fact','decision','entity','other')),
  importance REAL NOT NULL DEFAULT 0.7,
  embedding BLOB,
  source_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content=memories, content_rowid=rowid);
```

### Categories

| Category | Description | Examples |
|----------|-------------|----------|
| `preference` | User likes and dislikes | "Prefers dark mode", "Likes TypeScript" |
| `fact` | Factual information | "Dog's name is Max", "Server runs Ubuntu" |
| `decision` | Recorded decisions | "Using PostgreSQL", "Going with Tailwind" |
| `entity` | Named entities | Phone numbers, email addresses, named things |
| `other` | Anything else worth remembering | General context, observations |

### Hybrid Search

Two retrieval strategies combined:

1. **Vector search**: Semantic similarity via embeddings (catches paraphrases and related concepts)
2. **FTS5 keyword search**: BM25 ranking (catches exact tokens, IDs, code symbols)

Final score: `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Default weights: `vectorWeight = 0.7`, `textWeight = 0.3` (configurable).

### Duplicate Detection

Before storing a new memory, check for existing entries with cosine similarity >= 0.95. If a near-duplicate exists, update it instead of creating a new entry. This prevents the database from accumulating redundant information.

## Tier 4: Knowledge Vault (Obsidian)

**Location**: `~/.maia/workspace/knowledge/`

An interconnected graph of markdown notes designed to be opened in Obsidian.

### Structure

```
knowledge/
├── people/
│   ├── John Smith.md
│   └── Sarah Designer.md
├── projects/
│   ├── Maia Project.md
│   └── Website Redesign.md
├── topics/
│   ├── TypeScript Patterns.md
│   ├── Security Best Practices.md
│   └── PostgreSQL.md
└── Index.md
```

### Note Format

Every note follows Obsidian conventions:

```markdown
---
tags: [person, colleague]
created: 2026-02-13
updated: 2026-02-13
---

# John Smith

Backend developer on the [[Maia Project]].
Prefers [[TypeScript Patterns|TypeScript]] over JavaScript.
Works in the [[EST]] timezone.

## Notes
- Met during standup on 2026-02-13
- Recommended using [[PostgreSQL]] for the new service
```

Key elements:
- **YAML frontmatter**: `tags`, `created`, `updated`, `category`
- **`[[wikilinks]]`**: Connect related notes (bidirectional in Obsidian)
- **`#tags`**: Additional categorization
- **Hybrid organization**: Few top-level folders (`people/`, `projects/`, `topics/`), mostly linked via wikilinks

### Browsing

Open `~/.maia/workspace/knowledge/` as an Obsidian vault. The graph view shows how the agent connects people, projects, and concepts.

## End-of-Day Consolidation

The consolidation process bridges daily logs to all three long-term storage tiers.

### Trigger

- **Scheduled**: configurable time (default: end of day)
- **On-demand**: via CLI command or tool call
- **Automatic**: when a daily log exceeds a size threshold

### Process

```
1. Read today's daily log (memory/YYYY-MM-DD.md)
2. Send to LLM with consolidation prompt
3. LLM performs three extraction tasks:

   Task 1 -- Extract to Database (Tier 3):
   - Identify important items: preferences, facts, decisions, entities
   - Categorize and score importance
   - Embed each item
   - Store in SQLite (with duplicate detection)

   Task 2 -- Update MEMORY.md (Tier 2):
   - Review existing MEMORY.md
   - Add significant new context
   - Remove superseded information
   - Keep it concise and readable

   Task 3 -- Update Knowledge Vault (Tier 4):
   - Identify people, projects, topics mentioned
   - Create new notes or update existing ones
   - Add [[wikilinks]] to connect concepts
   - Ensure YAML frontmatter consistency

4. Daily log is left completely intact (never modified)
```

### Consolidation Prompt (Example)

```
You are reviewing today's conversation log. Extract and organize important information:

1. DATABASE ENTRIES: List items to store as structured memories.
   Format: { "text": "...", "category": "preference|fact|decision|entity|other", "importance": 0.0-1.0 }

2. MEMORY.MD UPDATES: What should be added to or removed from the curated notes?

3. KNOWLEDGE VAULT: What notes should be created or updated?
   For each: filename, folder (people/projects/topics), content, [[wikilinks]] to add.

Here is today's log:
---
{daily_log_content}
---

Here is the current MEMORY.md:
---
{memory_md_content}
---
```

## Auto-Recall

Before each agent turn, relevant memories are automatically injected into the context.

### Process

1. Embed the user's current message
2. Search the vector database (Tier 3) using hybrid search
3. Return top N results (configurable, default: 5)
4. Inject as a `<relevant-memories>` block in the system prompt

### Example

```xml
<relevant-memories>
- [preference] User prefers dark mode in all applications (importance: 0.9)
- [fact] User's dog is named Max (importance: 0.6)
- [decision] Using PostgreSQL for the new service (importance: 0.8)
</relevant-memories>
```

## Real-Time Capture

Some information is captured immediately, without waiting for consolidation:

- **Explicit requests**: "Remember that my meeting is at 3pm" triggers `memory_store`
- **Agent-initiated**: The agent calls `memory_store` during conversation when it identifies important info
- **MEMORY.md updates**: The agent can edit MEMORY.md at any time during a main session
- **Knowledge vault**: New notes can be created in real-time if a new concept or connection is identified
- **Daily log**: All real-time captures are also appended to the daily log for the audit trail

## Memory Tools

Three tools are available to the agent:

### `memory_search`
Search the vector database using hybrid search.

```json
{ "query": "TypeScript preferences", "category": "preference", "limit": 5 }
```

### `memory_store`
Store a new memory in the database (and append to daily log).

```json
{ "text": "User prefers ESM over CommonJS", "category": "preference", "importance": 0.8 }
```

### `memory_forget`
Delete a specific memory (GDPR-compliant deletion).

```json
{ "id": "mem_abc123" }
```

## Configuration

```json5
{
  "memory": {
    "enabled": true,
    "embeddingProvider": "ollama",
    "search": {
      "hybrid": { "enabled": true, "vectorWeight": 0.7, "textWeight": 0.3 }
    },
    "autoCapture": true,
    "autoRecall": true,
    "consolidation": {
      "schedule": "0 23 * * *",  // 11 PM daily
      "onDemand": true
    }
  }
}
```
