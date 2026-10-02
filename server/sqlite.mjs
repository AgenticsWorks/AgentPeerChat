import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Implements the small D1 SQL surface used by the shared API; batch stays atomic.
export class SQLiteDatabase {
  constructor(path) {
    this.sqlite = new DatabaseSync(path, { timeout: 5000 });
    this.sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  }
  prepare(sql) { return new Statement(this, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => statement.execute()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
  close() { this.sqlite.close(); }
  async migrate(directory) {
    this.sqlite.exec("CREATE TABLE IF NOT EXISTS agentgram_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))");
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      if (this.sqlite.prepare('SELECT 1 FROM agentgram_migrations WHERE name = ?').get(name)) continue;
      const sql = await readFile(join(directory, name), 'utf8');
      this.sqlite.exec('BEGIN IMMEDIATE');
      try { this.sqlite.exec(sql); this.sqlite.prepare('INSERT INTO agentgram_migrations(name) VALUES (?)').run(name); this.sqlite.exec('COMMIT'); }
      catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    }
  }
}
class Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.database, this.sql, values); }
  execute() {
    const statement = this.database.sqlite.prepare(this.sql);
    let results = [], changes = 0, lastRowId = 0;
    if (statement.columns().length) results = statement.all(...this.values).map(row => ({ ...row }));
    else { const result = statement.run(...this.values); changes = Number(result.changes); lastRowId = Number(result.lastInsertRowid); }
    return { success: true, results, meta: { changes, last_row_id: lastRowId, duration: 0 } };
  }
  async first(column) { const row = this.execute().results[0]; return row ? (column === undefined ? row : row[column]) : null; }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
}
