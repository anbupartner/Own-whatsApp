// Storage for campaigns, their attachments, run progress and locks.
// - Upstash Redis (REST) when UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN are set
// - Postgres (Vercel's Neon database) when DATABASE_URL or POSTGRES_URL is set
// - Otherwise JSON files in data/ (local use; on Vercel one of the databases above is needed)
const fs = require("fs");
const path = require("path");

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";
const PREFIX = process.env.STORE_PREFIX || "wa:";

function redisStore() {
  async function cmd(...args) {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error("Redis: " + (data.error || `HTTP ${r.status}`));
    return data.result;
  }
  return {
    kind: "redis",
    async get(key) {
      const v = await cmd("GET", PREFIX + key);
      return v == null ? null : JSON.parse(v);
    },
    // ttlSeconds: optional expiry (used for uploads that may never be attached)
    async set(key, value, ttlSeconds) {
      const args = ["SET", PREFIX + key, JSON.stringify(value)];
      if (ttlSeconds) args.push("EX", String(Math.ceil(ttlSeconds)));
      await cmd(...args);
    },
    async del(key) { await cmd("DEL", PREFIX + key); },
    // Returns true if this caller got the lock
    async lock(name, ttlSeconds) {
      return (await cmd("SET", PREFIX + "lock:" + name, String(Date.now()), "NX", "EX", String(Math.ceil(ttlSeconds)))) === "OK";
    },
    async unlock(name) { await cmd("DEL", PREFIX + "lock:" + name); },
  };
}

// Postgres (e.g. Vercel's Neon database). Everything lives in one table, wa_kv, so other tables are untouched.
// query(text, params) must return an array of row objects.
function postgresStore(query) {
  let ready = null;
  const init = () => (ready ??= query(`CREATE TABLE IF NOT EXISTS wa_kv (
      key text PRIMARY KEY,
      value text NOT NULL,
      expires_at timestamptz
    )`).catch((e) => { ready = null; throw e; }));
  const run = async (text, params) => { await init(); return query(text, params); };
  const ttl = (s) => (s ? new Date(Date.now() + s * 1000).toISOString() : null);
  return {
    kind: "postgres",
    async get(key) {
      const rows = await run("SELECT value FROM wa_kv WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())", [PREFIX + key]);
      return rows.length ? JSON.parse(rows[0].value) : null;
    },
    async set(key, value, ttlSeconds) {
      await run(
        `INSERT INTO wa_kv (key, value, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [PREFIX + key, JSON.stringify(value), ttl(ttlSeconds)],
      );
    },
    async del(key) { await run("DELETE FROM wa_kv WHERE key = $1", [PREFIX + key]); },
    // Returns true if this caller got the lock (a free lock row, or an expired one, is taken atomically)
    async lock(name, ttlSeconds) {
      const rows = await run(
        `INSERT INTO wa_kv (key, value, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
         WHERE wa_kv.expires_at IS NOT NULL AND wa_kv.expires_at <= now()
         RETURNING key`,
        [PREFIX + "lock:" + name, JSON.stringify(Date.now()), ttl(ttlSeconds)],
      );
      return rows.length > 0;
    },
    async unlock(name) { await run("DELETE FROM wa_kv WHERE key = $1", [PREFIX + "lock:" + name]); },
    async ping() { await run("SELECT 1", []); },
  };
}

// Neon's HTTP driver: works in serverless functions without a lasting connection
function neonQuery(url) {
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(url, { fullResults: false });
  return (text, params) => (typeof sql.query === "function" ? sql.query(text, params) : sql(text, params));
}

function fileStore(dir) {
  const file = (key) => path.join(dir, key.replace(/[^a-z0-9_-]/gi, "_") + ".json");
  const locks = new Map(); // single process, so in-memory locks are enough
  return {
    kind: "file",
    async get(key) {
      try { return JSON.parse(fs.readFileSync(file(key), "utf8")); } catch { return null; }
    },
    async set(key, value) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(key), JSON.stringify(value, null, 2));
    },
    async del(key) { fs.rmSync(file(key), { force: true }); },
    async lock(name, ttlSeconds) {
      const until = locks.get(name);
      if (until && until > Date.now()) return false;
      locks.set(name, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async unlock(name) { locks.delete(name); },
  };
}

const redisConfigured = Boolean(REDIS_URL && REDIS_TOKEN);
const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const postgresConfigured = Boolean(PG_URL);
const onVercel = Boolean(process.env.VERCEL);

// On Vercel the disk is not kept between requests, so only a database counts as storage there.
const store = redisConfigured ? redisStore()
  : postgresConfigured ? postgresStore(neonQuery(PG_URL))
  : onVercel ? null
  : fileStore(path.join(__dirname, "..", "data"));

module.exports = { store, redisConfigured, postgresConfigured, onVercel, postgresStore };
