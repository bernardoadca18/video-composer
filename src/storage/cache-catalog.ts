import { statSync, utimesSync } from 'node:fs';

import Database from 'better-sqlite3';

export type CacheKind = 'source' | 'narration' | 'music' | 'proxy' | 'program_audio';

interface CacheRow {
  sha256: string;
  byte_size: number;
  mtime_ms: number;
}

interface ProxyCacheRow extends CacheRow {
  profile_identity: string | null;
  integrity_state: string;
}

export class CacheCatalog {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache_catalog (
        cache_key TEXT PRIMARY KEY,
        cache_kind TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        profile_identity TEXT,
        integrity_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        verified_at TEXT NOT NULL,
        last_access_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_cache_catalog_access ON cache_catalog (cache_kind, last_access_at);
    `);
  }

  isHotValid(cacheKey: string, expectedSha256: string, expectedSize: number | null): boolean {
    const row = this.db
      .prepare('SELECT sha256, byte_size, mtime_ms FROM cache_catalog WHERE cache_key = ?')
      .get(cacheKey) as CacheRow | undefined;
    if (
      !row ||
      row.sha256 !== expectedSha256 ||
      (expectedSize !== null && row.byte_size !== expectedSize)
    ) {
      return false;
    }
    try {
      const current = statSync(cacheKey);
      if (
        !current.isFile() ||
        current.size !== row.byte_size ||
        Math.round(current.mtimeMs) !== row.mtime_ms
      ) {
        return false;
      }
      this.touch(cacheKey);
      return true;
    } catch {
      return false;
    }
  }

  isProxyHotValid(cacheKey: string, profileIdentity: string): boolean {
    const row = this.db
      .prepare(
        `SELECT sha256, byte_size, mtime_ms, profile_identity, integrity_state
         FROM cache_catalog WHERE cache_key = ? AND cache_kind = 'proxy'`,
      )
      .get(cacheKey) as ProxyCacheRow | undefined;
    if (!row || row.profile_identity !== profileIdentity || row.integrity_state !== 'verified') {
      return false;
    }
    try {
      const current = statSync(cacheKey);
      if (
        !current.isFile() ||
        current.size !== row.byte_size ||
        Math.round(current.mtimeMs) !== row.mtime_ms
      ) {
        return false;
      }
      this.touch(cacheKey);
      return true;
    } catch {
      return false;
    }
  }

  record(input: {
    cacheKey: string;
    cacheKind: CacheKind;
    sha256: string;
    byteSize: number;
    profileIdentity?: string;
  }): void {
    const details = statSync(input.cacheKey);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO cache_catalog (
          cache_key, cache_kind, path, sha256, byte_size, mtime_ms, profile_identity,
          integrity_state, created_at, verified_at, last_access_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          cache_kind = excluded.cache_kind, path = excluded.path, sha256 = excluded.sha256,
          byte_size = excluded.byte_size, mtime_ms = excluded.mtime_ms,
          profile_identity = excluded.profile_identity, integrity_state = 'verified',
          verified_at = excluded.verified_at, last_access_at = excluded.last_access_at`,
      )
      .run(
        input.cacheKey,
        input.cacheKind,
        input.cacheKey,
        input.sha256,
        input.byteSize,
        Math.round(details.mtimeMs),
        input.profileIdentity ?? null,
        now,
        now,
        now,
      );
  }

  touch(cacheKey: string): void {
    const now = new Date();
    utimesSync(cacheKey, now, now);
    const details = statSync(cacheKey);
    this.db
      .prepare('UPDATE cache_catalog SET last_access_at = ?, mtime_ms = ? WHERE cache_key = ?')
      .run(now.toISOString(), Math.round(details.mtimeMs), cacheKey);
  }

  close(): void {
    this.db.close();
  }
}
