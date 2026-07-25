// Cache backend — pluggable, because an in-memory cache is nearly useless where this
// actually runs. On serverless each invocation may be a fresh instance, so a per-process
// Map is discarded before the next pivot even starts: the cache "works" in a test and
// does nothing in production. When a database is configured we share the cache across
// instances, which is what makes deep multi-hop pivots affordable (and keeps us under
// source rate limits).

import { sql, dbEnabled } from "./db";

export interface CacheStore {
  get(key: string, ttlMs: number): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  clear(): Promise<void>;
  readonly kind: "memory" | "postgres";
}

// ---- in-memory (default, single instance) ----
class MemoryStore implements CacheStore {
  readonly kind = "memory" as const;
  private m = new Map<string, { at: number; v: string }>();
  private max = 500;
  async get(key: string, ttlMs: number): Promise<string | null> {
    const e = this.m.get(key);
    if (!e) return null;
    if (Date.now() - e.at > ttlMs) { this.m.delete(key); return null; }
    return e.v;
  }
  async set(key: string, value: string): Promise<void> {
    if (this.m.size >= this.max) {
      const drop = Math.ceil(this.max * 0.1);
      let i = 0;
      for (const k of this.m.keys()) { this.m.delete(k); if (++i >= drop) break; }
    }
    this.m.set(key, { at: Date.now(), v: value });
  }
  async clear(): Promise<void> { this.m.clear(); }
}

// ---- Postgres (shared across serverless instances) ----
class PgStore implements CacheStore {
  readonly kind = "postgres" as const;
  private ready: Promise<void> | null = null;
  private mem = new MemoryStore(); // L1 in front of the DB, same-invocation hits stay free

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const q = sql();
        if (!q) return;
        await q`CREATE TABLE IF NOT EXISTS octopus_cache (
          k        text PRIMARY KEY,
          v        text NOT NULL,
          at       bigint NOT NULL
        )`;
        await q`CREATE INDEX IF NOT EXISTS octopus_cache_at ON octopus_cache (at)`;
      })();
    }
    await this.ready;
  }

  async get(key: string, ttlMs: number): Promise<string | null> {
    const l1 = await this.mem.get(key, ttlMs);
    if (l1 !== null) return l1;
    try {
      await this.ensure();
      const q = sql();
      if (!q) return null;
      const cutoff = Date.now() - ttlMs;
      const rows = await q`SELECT v FROM octopus_cache WHERE k = ${key} AND at >= ${cutoff} LIMIT 1`;
      const v = (rows as any[])[0]?.v ?? null;
      if (v !== null) await this.mem.set(key, v);
      return v;
    } catch {
      return null; // a cache must never break a scan
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.mem.set(key, value);
    try {
      await this.ensure();
      const q = sql();
      if (!q) return;
      await q`INSERT INTO octopus_cache (k, v, at) VALUES (${key}, ${value}, ${Date.now()})
              ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, at = EXCLUDED.at`;
    } catch { /* best effort */ }
  }

  async clear(): Promise<void> {
    await this.mem.clear();
    try {
      await this.ensure();
      const q = sql();
      if (q) await q`DELETE FROM octopus_cache`;
    } catch { /* best effort */ }
  }
}

let store: CacheStore | null = null;

/** The active cache backend: Postgres when configured (shared), else memory. */
export function cacheStore(): CacheStore {
  if (!store) store = dbEnabled ? new PgStore() : new MemoryStore();
  return store;
}
