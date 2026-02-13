/**
 * @fileoverview Database migration runner for versioned SQL schema evolution.
 * @module core/migrations/runner
 *
 * @note Migrations are numbered SQL files (001_initial.sql, 002_add_field.sql, etc.)
 * read from a configurable directory. Forward-only; no down migrations.
 */

import type { Database, FileSystem, Logger } from "../types.js";

/**
 * @brief Dependencies for the migration runner.
 */
export interface MigrationRunnerDeps {
  readonly db: Database;
  readonly fs: FileSystem;
  readonly logger: Logger;
  readonly migrationsPath: string;
}

/**
 * @brief Migration runner interface.
 */
export interface MigrationRunner {
  run(): Promise<void>;
}

/**
 * @brief Creates a database migration runner.
 * @param deps - Injected dependencies
 * @returns MigrationRunner instance
 *
 * @example
 * const runner = createMigrationRunner({ db, fs, logger, migrationsPath: "/migrations" });
 * await runner.run(); // Applies pending migrations in order
 */
export function createMigrationRunner(deps: MigrationRunnerDeps): MigrationRunner {
  const { db, fs, logger } = deps;

  /**
   * @brief Ensure the schema_version table exists.
   */
  async function ensureVersionTable(): Promise<void> {
    await db.execute(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
    );
  }

  /**
   * @brief Get the current schema version.
   * @returns Current version number (0 if no migrations applied)
   */
  async function getCurrentVersion(): Promise<number> {
    const rows = await db.query<{ version: number }>(
      "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1"
    );
    return rows.length > 0 ? rows[0].version : 0;
  }

  /**
   * @brief Parse migration number from filename.
   * @param filename - Migration filename (e.g., "001_initial.sql")
   * @returns Migration number
   */
  function parseMigrationNumber(filename: string): number {
    const match = filename.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }

  return {
    async run(): Promise<void> {
      await ensureVersionTable();
      const currentVersion = await getCurrentVersion();

      // Read migration files
      let files: string[];
      try {
        files = await fs.readDir(deps.migrationsPath);
      } catch {
        logger.info("No migrations directory found, skipping.");
        return;
      }

      // Filter to .sql files and sort by number
      const migrations = files
        .filter((f) => f.endsWith(".sql"))
        .map((f) => ({ file: f, version: parseMigrationNumber(f) }))
        .filter((m) => m.version > currentVersion)
        .sort((a, b) => a.version - b.version);

      if (migrations.length === 0) {
        logger.info("Database schema is up to date.");
        return;
      }

      for (const migration of migrations) {
        const sql = await fs.readFile(`${deps.migrationsPath}/${migration.file}`);
        logger.info(`Applying migration ${migration.file}...`);

        try {
          await db.execute(sql);
          await db.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
            [migration.version, new Date().toISOString()]
          );
          logger.info(`Migration ${migration.file} applied successfully.`);
        } catch (error) {
          logger.error(`Migration ${migration.file} failed.`, {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
    },
  };
}
