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
    // Many keys in one round trip; returns values in the same order (null for missing ones)
    async mget(keys) {
      if (!keys.length) return [];
      return (await cmd("MGET", ...keys.map((k) => PREFIX + k))).map((v) => (v == null ? null : JSON.parse(v)));
    },
    // Returns true if this caller got the lock
    async lock(name, ttlSeconds) {
      return (await cmd("SET", PREFIX + "lock:" + name, String(Date.now()), "NX", "EX", String(Math.ceil(ttlSeconds)))) === "OK";
    },
    async unlock(name) { await cmd("DEL", PREFIX + "lock:" + name); },
    // Atomic add; returns the new value
    async incr(key, n = 1) { return Number(await cmd("INCRBY", PREFIX + key, String(n))); },
    // Atomic list add / remove (a Lua script runs as one step in Redis). field: match objects by this key.
    async listAdd(key, item, field = "") {
      return (await cmd("EVAL", LUA_LIST_ADD, "1", PREFIX + key, JSON.stringify(item), field)) === 1;
    },
    async listRemove(key, value, field = "") {
      return (await cmd("EVAL", LUA_LIST_REMOVE, "1", PREFIX + key, JSON.stringify(value), field)) === 1;
    },
  };
}
const LUA_LIST_ADD = `
local v = redis.call('GET', KEYS[1]); local a = {}
if v then a = cjson.decode(v) end
local item = cjson.decode(ARGV[1]); local f = ARGV[2]
for _, e in ipairs(a) do
  if (f == '' and e == item) or (f ~= '' and type(e) == 'table' and e[f] == item[f]) then return 0 end
end
table.insert(a, item)
redis.call('SET', KEYS[1], cjson.encode(a))
return 1`;
const LUA_LIST_REMOVE = `
local v = redis.call('GET', KEYS[1]); if not v then return 0 end
local a = cjson.decode(v); local val = cjson.decode(ARGV[1]); local f = ARGV[2]
local b = {}; local removed = 0
for _, e in ipairs(a) do
  if (f == '' and e == val) or (f ~= '' and type(e) == 'table' and e[f] == val) then removed = 1 else table.insert(b, e) end
end
if #b == 0 then redis.call('SET', KEYS[1], '[]') else redis.call('SET', KEYS[1], cjson.encode(b)) end
return removed`;

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
    // Many keys in one query; returns values in the same order (null for missing ones)
    async mget(keys) {
      if (!keys.length) return [];
      const rows = await run("SELECT key, value FROM wa_kv WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now())", [keys.map((k) => PREFIX + k)]);
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return keys.map((k) => (byKey.has(PREFIX + k) ? JSON.parse(byKey.get(PREFIX + k)) : null));
    },
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
    // Atomic add in one statement (safe when several webhook calls arrive at once); returns the new value
    async incr(key, n = 1) {
      const rows = await run(
        `INSERT INTO wa_kv (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = ((wa_kv.value)::bigint + $3)::text
         RETURNING value`,
        [PREFIX + key, String(n), n],
      );
      return Number(rows[0].value);
    },
    // Atomic list add: one statement, so simultaneous adds can't overwrite each other.
    // item: a string, or an object matched by `field` (e.g. { phone } on the do-not-contact list). true if added.
    async listAdd(key, item, field = "") {
      const match = JSON.stringify([field ? { [field]: item[field] } : item]);
      const rows = await run(
        `INSERT INTO wa_kv (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = (wa_kv.value::jsonb || $3::jsonb)::text
         WHERE NOT (wa_kv.value::jsonb @> $4::jsonb)
         RETURNING key`,
        [PREFIX + key, JSON.stringify([item]), JSON.stringify([item]), match],
      );
      return rows.length > 0;
    },
    // Atomic list remove (a string, or objects whose `field` equals value). true if something was removed.
    async listRemove(key, value, field = "") {
      const rows = field
        ? await run(
          `UPDATE wa_kv SET value = COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(value::jsonb) e WHERE e->>$2 IS DISTINCT FROM $3), '[]'::jsonb)::text
           WHERE key = $1 AND value::jsonb @> $4::jsonb RETURNING key`,
          [PREFIX + key, field, String(value), JSON.stringify([{ [field]: value }])])
        : await run(
          `UPDATE wa_kv SET value = (value::jsonb - $2)::text WHERE key = $1 AND value::jsonb ? $2 RETURNING key`,
          [PREFIX + key, String(value)]);
      return rows.length > 0;
    },
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
    async mget(keys) { return Promise.all(keys.map((k) => this.get(k))); },
    async lock(name, ttlSeconds) {
      const until = locks.get(name);
      if (until && until > Date.now()) return false;
      locks.set(name, Date.now() + ttlSeconds * 1000);
      return true;
    },
    async unlock(name) { locks.delete(name); },
    // single process and no await between read and write, so these are atomic
    async listAdd(key, item, field = "") {
      let a = [];
      try { a = JSON.parse(fs.readFileSync(file(key), "utf8")); } catch { /* new */ }
      if (!Array.isArray(a)) a = [];
      if (a.some((e) => (field ? e && e[field] === item[field] : e === item))) return false;
      a.push(item);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(key), JSON.stringify(a, null, 2));
      return true;
    },
    async listRemove(key, value, field = "") {
      let a = [];
      try { a = JSON.parse(fs.readFileSync(file(key), "utf8")); } catch { return false; }
      if (!Array.isArray(a)) return false;
      const b = a.filter((e) => !(field ? e && e[field] === value : e === value));
      if (b.length === a.length) return false;
      fs.writeFileSync(file(key), JSON.stringify(b, null, 2));
      return true;
    },
    async incr(key, n = 1) {
      let v = 0;
      try { v = Number(JSON.parse(fs.readFileSync(file(key), "utf8"))) || 0; } catch { /* new */ }
      v += n;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file(key), JSON.stringify(v));
      return v;
    },
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
