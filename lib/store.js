// Storage for campaigns, their attachments, run progress and locks.
// - Upstash Redis (REST) when UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN are set (needed on Vercel)
// - Otherwise JSON files in data/ (local use)
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
const onVercel = Boolean(process.env.VERCEL);

// On Vercel the disk is not kept between requests, so only Redis counts as storage there.
const store = redisConfigured ? redisStore() : onVercel ? null : fileStore(path.join(__dirname, "..", "data"));

module.exports = { store, redisConfigured, onVercel };
