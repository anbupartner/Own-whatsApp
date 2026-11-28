// Shared app logic used by both the local server (server.js) and the Vercel function (api/[...path].js).
const crypto = require("crypto");
const { store, redisConfigured, postgresConfigured, onVercel } = require("./store");

const env = process.env;
const TOKEN = env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = env.WHATSAPP_PHONE_NUMBER_ID || "";
const API_VERSION = env.GRAPH_API_VERSION || "v21.0";
const GRAPH_BASE = (env.GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
const APP_PASSWORD = env.APP_PASSWORD || "";
const CRON_SECRET = env.CRON_SECRET || "";
const apiConfigured = () => Boolean(TOKEN && PHONE_NUMBER_ID);

// On Vercel a function may run for maxDuration seconds (vercel.json). A run stops sending
// a bit before that and continues on the next cron call.
const RUN_BUDGET_MS = onVercel ? (Number(env.RUN_BUDGET_SECONDS) || 270) * 1000 : Infinity;
// A scheduled run found more than this late is skipped instead of sent late
const MISSED_GRACE_MS = (Number(env.MISSED_GRACE_HOURS) || 6) * 3600000;
// Vercel rejects request bodies over 4.5 MB
const VERCEL_BODY_LIMIT = 4.4 * 1024 * 1024;

function log(...a) { console.log(new Date().toISOString(), "-", ...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("File too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req, limit = 1e6) {
  const buf = await readRaw(req, limit);
  return buf.length ? JSON.parse(buf.toString("utf8")) : {};
}

// ======================= Login and user accounts =======================
// Users are stored as user:<username> = { username, name, role: "admin"|"user", salt, hash, pwv, mustChange,
// createdAt, createdBy, lastLoginAt }. Passwords are scrypt hashes; pwv changes on every password change,
// which signs out that user's other sessions.
// The first admin is APP_USERNAME (default "admin") with the APP_PASSWORD from the environment. That login
// also works later as a recovery login for that admin (and then asks for a new password).
// With no database, only that one APP_USERNAME / APP_PASSWORD login exists.
// On Vercel the app is public, so it refuses to work until APP_PASSWORD is set.

const ADMIN_USERNAME = String(env.APP_USERNAME || "admin").trim().toLowerCase();
const authRequired = Boolean(APP_PASSWORD) || onVercel;
const authMisconfigured = onVercel && !APP_PASSWORD;
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_SECONDS = 600;
const sessionKey = crypto.createHash("sha256").update("wa-session:" + (env.SESSION_SECRET || "") + ":" + APP_PASSWORD).digest();
const sign = (s) => crypto.createHmac("sha256", sessionKey).update(s).digest("base64url");
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function cookieAttrs(req) {
  const secure = onVercel || req.headers["x-forwarded-proto"] === "https";
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString("hex");
  return { salt, hash };
}
function checkPassword(user, password) {
  if (!user?.salt || !user?.hash) return false;
  const { hash } = hashPassword(password || "", user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}
function passwordProblem(p) {
  if (String(p || "").length < 8) return "Password must be at least 8 characters";
  if (String(p).length > 200) return "Password is too long";
  return null;
}
// Readable one-time password for admin resets (no look-alike characters)
function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.randomBytes(12), (b) => chars[b % chars.length]).join("");
}

const getUser = async (u) => (store ? store.get("user:" + u) : null);
const saveUser = async (user) => store.set("user:" + user.username, user);
async function userNames() { return (store && (await store.get("users"))) || []; }
const publicUser = (u) => ({ username: u.username, name: u.name || u.username, role: u.role, mustChange: Boolean(u.mustChange) });

function makeSession(username, pwv) {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  const u = Buffer.from(username).toString("base64url");
  const body = `${u}.${exp}.${pwv}`;
  return `${body}.${sign(body)}`;
}
const sessionCookie = (req, value) => `wa_session=${value}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`;

// The logged-in user for this request, or null
async function currentUser(req) {
  if (!authRequired) return { username: "local", name: "Local", role: "admin", mustChange: false };
  if (authMisconfigured) return null;
  const v = getCookie(req, "wa_session");
  if (!v) return null;
  const parts = v.split(".");
  if (parts.length !== 4) return null;
  const [u, exp, pwv, sig] = parts;
  if (!(Number(exp) > Date.now()) || !safeEqual(sig, sign(`${u}.${exp}.${pwv}`))) return null;
  const username = Buffer.from(u, "base64url").toString();
  if (pwv === "env") return username === ADMIN_USERNAME && !store ? { username, name: "Admin", role: "admin", mustChange: false } : null;
  const user = await getUser(username);
  if (!user || String(user.pwv) !== pwv) return null; // deleted, or password changed since
  return publicUser(user);
}

async function handleLogin(req, res) {
  if (authMisconfigured) return sendJson(res, 503, { ok: false, error: "Set the APP_PASSWORD environment variable in Vercel, then redeploy." });
  if (!authRequired) return sendJson(res, 200, { ok: true, user: await currentUser(req) });
  let b;
  try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  const username = String(b.username || "").trim().toLowerCase();
  const password = String(b.password || "");
  const bad = async () => {
    if (store && username) await store.set("fail:" + username, ((await store.get("fail:" + username)) || 0) + 1, LOCK_SECONDS);
    await sleep(700); // slow down guessing
    return sendJson(res, 401, { ok: false, error: "Wrong username or password" });
  };
  if (!username || !password) return sendJson(res, 400, { ok: false, error: "Enter your username and password" });
  if (store && ((await store.get("fail:" + username)) || 0) >= MAX_FAILS) {
    return sendJson(res, 429, { ok: false, error: "Too many wrong tries. Wait 10 minutes, or ask your admin." });
  }

  // No database: one login from the environment
  if (!store) {
    if (username !== ADMIN_USERNAME || !safeEqual(password, APP_PASSWORD)) return bad();
    return sendJson(res, 200, { ok: true, user: { username, name: "Admin", role: "admin", mustChange: false } }, { "Set-Cookie": sessionCookie(req, makeSession(username, "env")) });
  }

  let user = await getUser(username);
  let recovery = false;
  if (!(user && checkPassword(user, password))) {
    // The environment admin login: creates the first admin, or works as a recovery login for that admin
    if (username === ADMIN_USERNAME && safeEqual(password, APP_PASSWORD)) {
      if (!user) {
        user = { username, name: "Admin", role: "admin", ...hashPassword(password), pwv: 1, mustChange: false, createdAt: new Date().toISOString(), createdBy: "setup" };
        await store.set("users", [...new Set([...(await userNames()), username])]);
        log(`User "${username}" created from APP_PASSWORD`);
      } else {
        recovery = true;
        user.mustChange = true; // recovery login: choose a new password now
      }
    } else {
      return bad();
    }
  }
  user.lastLoginAt = new Date().toISOString();
  await saveUser(user);
  await store.del("fail:" + username);
  if (recovery) log(`Recovery login for "${username}"`);
  return sendJson(res, 200, { ok: true, user: publicUser(user) }, { "Set-Cookie": sessionCookie(req, makeSession(username, user.pwv)) });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, { "Set-Cookie": `wa_session=; Max-Age=0; ${cookieAttrs(req)}` });
}

// Change your own password (also used after an admin reset or a recovery login)
async function handleChangePassword(req, res, me) {
  if (!store) return sendJson(res, 400, { ok: false, error: "Without a database, change APP_PASSWORD in Vercel instead." });
  let b;
  try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  const user = await getUser(me.username);
  if (!user) return sendJson(res, 404, { ok: false, error: "User not found" });
  if (!user.mustChange && !checkPassword(user, b.current)) return sendJson(res, 400, { ok: false, error: "Your current password is not right" });
  const problem = passwordProblem(b.next);
  if (problem) return sendJson(res, 400, { ok: false, error: problem });
  if (checkPassword(user, b.next)) return sendJson(res, 400, { ok: false, error: "Choose a password different from the old one" });
  Object.assign(user, hashPassword(b.next), { pwv: (Number(user.pwv) || 0) + 1, mustChange: false, passwordChangedAt: new Date().toISOString() });
  await saveUser(user);
  log(`User "${user.username}" changed their password`);
  // new session cookie, since the old one carries the old password version
  return sendJson(res, 200, { ok: true, user: publicUser(user) }, { "Set-Cookie": sessionCookie(req, makeSession(user.username, user.pwv)) });
}

// ---- Admin: manage users ----
async function listUsers() {
  const list = (await Promise.all((await userNames()).map(getUser))).filter(Boolean);
  return list.map((u) => ({ ...publicUser(u), createdAt: u.createdAt, createdBy: u.createdBy, lastLoginAt: u.lastLoginAt || null }));
}

async function handleUsers(req, res, me, sub, action) {
  if (!store) return sendJson(res, 400, { ok: false, error: "User accounts need a database (connect Neon in Vercel)." });
  if (me.role !== "admin") return sendJson(res, 403, { ok: false, error: "Only admins can manage users" });
  const admins = async () => (await listUsers()).filter((u) => u.role === "admin").map((u) => u.username);

  if (!sub && req.method === "GET") return sendJson(res, 200, { ok: true, users: await listUsers() });

  if (!sub && req.method === "POST") {
    let b;
    try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
    const username = String(b.username || "").trim().toLowerCase();
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { ok: false, error: "Username: 3–32 characters, letters, numbers, dot, dash or underscore" });
    if (await getUser(username)) return sendJson(res, 409, { ok: false, error: "That username is taken" });
    const temp = tempPassword();
    const user = {
      username, name: String(b.name || "").trim().slice(0, 60) || username, role: b.role === "admin" ? "admin" : "user",
      ...hashPassword(temp), pwv: 1, mustChange: true, createdAt: new Date().toISOString(), createdBy: me.username,
    };
    await saveUser(user);
    await store.set("users", [...new Set([...(await userNames()), username])]);
    log(`User "${username}" added by "${me.username}"`);
    return sendJson(res, 200, { ok: true, tempPassword: temp, users: await listUsers() });
  }

  if (sub === "requests" && req.method === "GET") return sendJson(res, 200, { ok: true, requests: await listResetRequests() });
  const user = await getUser(sub);
  if (!user) return sendJson(res, 404, { ok: false, error: "User not found" });
  if (action === "approve-reset" || action === "decline-reset") {
    const r = await decideResetRequest(user.username, action === "approve-reset", me);
    if (!r.ok) return sendJson(res, 404, r);
    return sendJson(res, 200, { ok: true, requests: await listResetRequests() });
  }
  if (action === "reset") {
    const temp = tempPassword();
    Object.assign(user, hashPassword(temp), { pwv: (Number(user.pwv) || 0) + 1, mustChange: true });
    await saveUser(user);
    await store.del("fail:" + user.username);
    log(`Password of "${user.username}" reset by "${me.username}"`);
    return sendJson(res, 200, { ok: true, tempPassword: temp, users: await listUsers() });
  }
  if (action === "role") {
    let b;
    try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
    const role = b.role === "admin" ? "admin" : "user";
    if (role === "user" && user.role === "admin" && (await admins()).length <= 1) return sendJson(res, 400, { ok: false, error: "There must be at least one admin" });
    user.role = role;
    await saveUser(user);
    return sendJson(res, 200, { ok: true, users: await listUsers() });
  }
  if (action === "delete") {
    if (user.username === me.username) return sendJson(res, 400, { ok: false, error: "You can't delete your own account" });
    if (user.role === "admin" && (await admins()).length <= 1) return sendJson(res, 400, { ok: false, error: "There must be at least one admin" });
    await store.del("user:" + user.username);
    await store.set("users", (await userNames()).filter((x) => x !== user.username));
    log(`User "${user.username}" deleted by "${me.username}"`);
    return sendJson(res, 200, { ok: true, users: await listUsers() });
  }
  return sendJson(res, 404, { ok: false, error: "Unknown action" });
}

// ---- Forgot password: request → admin approves → user sets a new password ----
// resetreq:<username> = { username, checkCode, codeHash, createdAt, expiresAt, status: "pending"|"approved"|"declined",
//                         decidedBy, decidedAt }   (kept 24 h)
// resetreqs = list of usernames with a request (index for the admin list)
// The requester gets a short check code (to read to the admin, proving the request is theirs) and a
// request code (secret, used to set the new password after approval). Answers never reveal whether
// a username exists.
const RESET_HOURS = 24;
const RESET_THROTTLE_MS = 2 * 60 * 1000;
const codeHash = (username, code) => crypto.createHash("sha256").update(`reset:${username}:${String(code).replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`).digest("hex");
const requestCode = () => { const c = tempPassword().slice(0, 10).toUpperCase(); return `${c.slice(0, 5)}-${c.slice(5)}`; };
const checkCode = () => String(crypto.randomInt(1000, 10000));

async function getResetRequest(username) {
  const r = await store.get("resetreq:" + username);
  if (r && Date.parse(r.expiresAt) < Date.now()) { await store.del("resetreq:" + username); return null; }
  return r;
}

async function handleResetRequest(req, res) {
  if (!store) return sendJson(res, 400, { ok: false, error: "Password reset requests need a database. Ask your admin." });
  let b;
  try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  const username = String(b.username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) return sendJson(res, 400, { ok: false, error: "Enter your username" });
  // One request per username every 2 minutes; applied to every username so it reveals nothing
  if (await store.get("resetthrottle:" + username)) {
    return sendJson(res, 429, { ok: false, error: "A request was just made for this username. Wait 2 minutes before asking again." });
  }
  await store.set("resetthrottle:" + username, 1, RESET_THROTTLE_MS / 1000);
  const code = requestCode(), check = checkCode();
  const user = await getUser(username);
  if (user) {
    const now = Date.now();
    await store.set("resetreq:" + username, {
      username, checkCode: check, codeHash: codeHash(username, code), status: "pending",
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RESET_HOURS * 3600000).toISOString(),
    }, RESET_HOURS * 3600);
    const idx = (await store.get("resetreqs")) || [];
    if (!idx.includes(username)) await store.set("resetreqs", [...idx, username]);
    log(`Password reset requested for "${username}"`);
  } else {
    await sleep(200 + Math.random() * 300); // same answer and similar timing for unknown usernames
  }
  return sendJson(res, 200, { ok: true, requestCode: code, checkCode: check, expiresInHours: RESET_HOURS });
}

// Check a request (and, with a new password, finish it)
async function handleResetComplete(req, res, finish) {
  if (!store) return sendJson(res, 400, { ok: false, error: "Password reset requests need a database. Ask your admin." });
  let b;
  try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  const username = String(b.username || "").trim().toLowerCase();
  const failKey = "resetfail:" + username;
  if (((await store.get(failKey)) || 0) >= MAX_FAILS) return sendJson(res, 429, { ok: false, error: "Too many wrong codes. Wait 10 minutes." });
  const r = USERNAME_RE.test(username) ? await getResetRequest(username) : null;
  if (!r || !safeEqual(r.codeHash, codeHash(username, b.requestCode))) {
    await store.set(failKey, ((await store.get(failKey)) || 0) + 1, LOCK_SECONDS);
    await sleep(500);
    return sendJson(res, 404, { ok: false, status: "none", error: "No request matches this username and request code. It may have expired (24 h); make a new request." });
  }
  if (r.status === "pending") return sendJson(res, 200, { ok: true, status: "pending", requestedAt: r.createdAt });
  if (r.status === "declined") return sendJson(res, 200, { ok: true, status: "declined" });
  if (!finish) return sendJson(res, 200, { ok: true, status: "approved" });

  const problem = passwordProblem(b.newPassword);
  if (problem) return sendJson(res, 400, { ok: false, status: "approved", error: problem });
  const user = await getUser(username);
  if (!user) return sendJson(res, 404, { ok: false, status: "none", error: "This account no longer exists" });
  Object.assign(user, hashPassword(b.newPassword), { pwv: (Number(user.pwv) || 0) + 1, mustChange: false, passwordChangedAt: new Date().toISOString() });
  await saveUser(user);
  await store.del("resetreq:" + username);
  await store.set("resetreqs", ((await store.get("resetreqs")) || []).filter((x) => x !== username));
  await store.del(failKey);
  await store.del("fail:" + username);
  log(`Password of "${username}" set through an approved reset request`);
  return sendJson(res, 200, { ok: true, status: "done" });
}

// Admin: list open requests (also tidies the index)
async function listResetRequests() {
  const idx = (await store.get("resetreqs")) || [];
  const items = [];
  for (const u of idx) {
    const r = await getResetRequest(u);
    if (!r) continue;
    const user = await getUser(u);
    if (!user) { await store.del("resetreq:" + u); continue; }
    items.push({ username: u, name: user.name || u, checkCode: r.checkCode, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt, decidedBy: r.decidedBy || null });
  }
  if (items.length !== idx.length) await store.set("resetreqs", items.map((i) => i.username));
  return items.sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

async function decideResetRequest(username, approve, me) {
  const r = await getResetRequest(username);
  if (!r) return { ok: false, error: "This request has expired or was already used" };
  r.status = approve ? "approved" : "declined";
  r.decidedBy = me.username;
  r.decidedAt = new Date().toISOString();
  await store.set("resetreq:" + username, r, Math.max(60, Math.round((Date.parse(r.expiresAt) - Date.now()) / 1000)));
  if (approve) {
    // sign the user out everywhere; they set the new password with their request code
    const user = await getUser(username);
    if (user) { user.pwv = (Number(user.pwv) || 0) + 1; await saveUser(user); }
  }
  log(`Reset request of "${username}" ${r.status} by "${me.username}"`);
  return { ok: true };
}

// ======================= WhatsApp Cloud API =======================

const MEDIA_RULES = {
  image: { max: 5 * 1024 * 1024, types: ["image/jpeg", "image/png"] },
  document: { max: 100 * 1024 * 1024, types: null },
};
const mediaKind = (mime) => (MEDIA_RULES.image.types.includes(mime) ? "image" : "document");
const maxUpload = (kind) => Math.min(MEDIA_RULES[kind].max, onVercel ? VERCEL_BODY_LIMIT : Infinity);

function mediaObject(media) {
  const obj = media.id ? { id: media.id } : { link: media.link };
  if (media.kind === "document" && media.filename) obj.filename = media.filename;
  return obj;
}

// Build the Cloud API payload for one recipient
function buildPayload({ to, type, text, template, media }) {
  if (type === "template") {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: template.name, language: { code: template.language || "en_US" } },
    };
    const components = [];
    // Template with an IMAGE or DOCUMENT header: the attachment goes in the header
    if (media) components.push({ type: "header", parameters: [{ type: media.kind, [media.kind]: mediaObject(media) }] });
    const params = (template.params || []).filter((p) => p !== undefined);
    if (params.length) components.push({ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) });
    if (components.length) payload.template.components = components;
    return payload;
  }
  if (media) {
    const obj = mediaObject(media);
    if (text && text.trim()) obj.caption = text;
    return { messaging_product: "whatsapp", recipient_type: "individual", to, type: media.kind, [media.kind]: obj };
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body: text } };
}

async function sendMessage(msg) {
  try {
    const r = await fetch(`${GRAPH_BASE}/${API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(msg)),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
    return { ok: true, id: data?.messages?.[0]?.id || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function uploadMedia(buf, mime, filename) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([buf], { type: mime }), filename);
  try {
    const r = await fetch(`${GRAPH_BASE}/${API_VERSION}/${PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function readMediaRequest(req) {
  const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
  const filename = decodeURIComponent(String(req.headers["x-filename"] || "file"));
  const kind = mediaKind(mime);
  if (mime.startsWith("image/") && kind !== "image") throw new Error("Images must be JPEG or PNG");
  const max = maxUpload(kind);
  let buf;
  try { buf = await readRaw(req, max); }
  catch (e) { throw new Error(`${e.message} (max ${(max / 1048576).toFixed(1)} MB for ${kind}s here${onVercel ? "; use a public https link for bigger files" : ""})`); }
  if (!buf.length) throw new Error("Empty file");
  return { buf, mime, filename, kind };
}

// ======================= Single sends from the page =======================

function validateMedia(m) {
  if (!m) return null;
  if (!["image", "document"].includes(m.kind)) return "Attachment must be an image or document";
  if (!m.id && !/^https:\/\//i.test(m.link || "")) return "Attachment needs an uploaded file or an https link";
  return null;
}

const notConfigured = (res) => sendJson(res, 400, { ok: false, error: "Cloud API not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID." });

async function handleSend(req, res) {
  if (!apiConfigured()) return notConfigured(res);
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  const to = String(body.to || "").replace(/\D/g, "");
  if (to.length < 8) return sendJson(res, 400, { ok: false, error: "Invalid phone number" });
  if (body.type === "template" && !body.template?.name) return sendJson(res, 400, { ok: false, error: "Template name missing" });
  const mErr = validateMedia(body.media);
  if (mErr) return sendJson(res, 400, { ok: false, error: mErr });
  if (body.type !== "template" && !body.media && !String(body.text || "").trim()) return sendJson(res, 400, { ok: false, error: "Message is empty" });
  return sendJson(res, 200, await sendMessage({ ...body, to }));
}

async function handleUpload(req, res) {
  if (!apiConfigured()) return notConfigured(res);
  let f;
  try { f = await readMediaRequest(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const r = await uploadMedia(f.buf, f.mime, f.filename);
  return sendJson(res, 200, r.ok ? { ...r, kind: f.kind, filename: f.filename } : r);
}

// ======================= Time zones =======================

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return Boolean(tz); } catch { return false; }
}
function tzParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
function tzOffset(ms, tz) {
  const t = Math.floor(ms / 1000) * 1000;
  const p = tzParts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
}
// UTC time of a wall-clock time in a time zone
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffset(guess, tz);
  let t = guess - off;
  const off2 = tzOffset(t, tz);
  if (off2 !== off) t = guess - off2;
  return t;
}

// Next run time (ISO) after `from`, or null when a one-time campaign's time has passed
function computeNext(schedule, from = Date.now()) {
  if (schedule.type === "once") {
    const t = Date.parse(schedule.at);
    return t > from ? new Date(t).toISOString() : null;
  }
  if (schedule.type === "daily") {
    const tz = validTz(schedule.tz) ? schedule.tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const [h, m] = String(schedule.time || "09:00").split(":").map(Number);
    const p = tzParts(from, tz);
    let t = zonedToUtc(p.year, p.month, p.day, h, m, tz);
    if (t <= from) {
      const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
      t = zonedToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, m, tz);
    }
    return new Date(t).toISOString();
  }
  const n = Math.max(1, Number(schedule.every) || 1);
  return new Date(from + n * (schedule.type === "hours" ? 3600000 : 60000)).toISOString();
}

// ======================= Campaigns =======================
// Stored keys:
//   campaigns        list of campaign ids
//   c:<id>           campaign = { id, name, enabled, finished, schedule:{type,time,every,at,tz},
//                      interval:{min,max,batchSize,batchPause}, message:{type,template?},
//                      media:{kind,source,link?,filename}|null, contacts:[{phone,name,text,params}],
//                      nextRunAt, runNowRequested, createdAt, runs:[{at,text}], lastResults:[...] }
//   m:<id>           attachment file of a campaign { mime, filename, kind, base64 }
//   u:<uploadId>     uploaded file waiting to be attached to a new campaign
//   r:<id>           run in progress (survives function time limits and restarts)
//   s:<id>           stop request for a run
// Only one campaign sends at a time (global lock "run"); due campaigns wait their turn.

const noStore = (res) => sendJson(res, 503, {
  ok: false,
  error: onVercel ? "No database connected. Connect a database (Neon Postgres or Upstash Redis) in the Vercel project's Storage tab, then redeploy." : "Storage not available",
});

const newId = () => crypto.randomBytes(6).toString("hex");

function addRun(c, text) {
  c.runs = [{ at: new Date().toISOString(), text }, ...(c.runs || [])].slice(0, 20);
  log(`Campaign "${c.name}":`, text);
}

// Campaign ids. Converts the older single saved schedule ("job") into a campaign once.
async function campaignIds() {
  let ids = await store.get("campaigns");
  if (ids) return ids;
  ids = [];
  const job = await store.get("job");
  if (job) {
    const id = newId();
    const media = await store.get("media");
    await store.set("c:" + id, { ...job, id, name: "Campaign 1", finished: false, runNowRequested: false, createdAt: job.savedAt || new Date().toISOString() });
    if (media) await store.set("m:" + id, media);
    await store.del("job"); await store.del("media"); await store.del("run"); await store.del("stop");
    ids.push(id);
  }
  await store.set("campaigns", ids);
  return ids;
}

async function allCampaigns() {
  const ids = await campaignIds();
  const list = await Promise.all(ids.map((id) => store.get("c:" + id)));
  return list.filter(Boolean);
}

function randomGap(interval) {
  let a = Math.max(1, Number(interval.min) || 1);
  let b = Math.max(1, Number(interval.max) || a);
  if (b < a) [a, b] = [b, a];
  return (a + Math.random() * (b - a)) * 1000;
}

const newRun = (c, trigger) => ({
  trigger, startedAt: new Date().toISOString(), cursor: 0, total: c.contacts.length,
  sent: 0, failed: 0, results: [], mediaId: null, waitUntil: null, waitLabel: null, pausedAt: null,
});

async function finishRun(id, run, note) {
  const c = await store.get("c:" + id); // re-read: it may have been paused/resumed meanwhile
  if (c) {
    const name = run.trigger === "scheduled" ? "Scheduled" : "Manual";
    addRun(c, note
      ? `${name} run failed: ${note}`
      : run.cancelled
        ? `${name} run cancelled: sent ${run.sent}, failed ${run.failed}, not sent ${run.total - run.cursor} of ${run.total}`
        : `${name} run finished: sent ${run.sent}, failed ${run.failed} of ${run.total}`);
    c.lastResults = run.results;
    await store.set("c:" + id, c);
  }
  await store.del("r:" + id);
  await store.del("s:" + id);
  return "finished";
}

// Send the run's remaining messages until done, stopped, or the time budget is used up.
async function processRun(c, run, deadline) {
  const id = c.id;
  run.pausedAt = null;
  // s:<id> is "stop" (keep progress, can resume) or "cancel" (end the run)
  const stopped = async () => Boolean(await store.get("s:" + id));
  const handleStop = async () => {
    const req = await store.get("s:" + id);
    await store.del("s:" + id);
    if (req === "cancel") { run.cancelled = true; return finishRun(id, run); }
    run.held = true;
    run.waitUntil = null;
    await store.set("r:" + id, run);
    const cur = await store.get("c:" + id);
    if (cur) { addRun(cur, `Stopped after ${run.cursor} of ${run.total} (sent ${run.sent}, failed ${run.failed})`); await store.set("c:" + id, cur); }
    return "held";
  };

  let media = null;
  if (c.media?.source === "file") {
    if (!run.mediaId) {
      const m = await store.get("m:" + id);
      if (!m) return finishRun(id, run, "attachment file missing");
      const up = await uploadMedia(Buffer.from(m.base64, "base64"), m.mime, m.filename);
      if (!up.ok) return finishRun(id, run, "attachment upload failed: " + up.error);
      run.mediaId = up.id;
      await store.set("r:" + id, run);
    }
    media = { kind: c.media.kind, id: run.mediaId, filename: c.media.filename };
  } else if (c.media?.source === "link") {
    media = { kind: c.media.kind, link: c.media.link, filename: c.media.filename };
  }

  const batchSize = Math.max(0, Number(c.interval.batchSize) || 0);
  const batchPause = Math.max(0, Number(c.interval.batchPause) || 0) * 1000;
  const pause = async () => { run.pausedAt = new Date().toISOString(); await store.set("r:" + id, run); return "paused"; };

  while (run.cursor < run.total) {
    if (await stopped()) return handleStop();

    // Wait out the gap, checking for Stop and the time budget
    if (run.waitUntil && Date.now() < run.waitUntil) {
      const until = Math.min(run.waitUntil, deadline - 5000);
      while (Date.now() < until) {
        await sleep(Math.min(store.kind === "redis" ? 2000 : 500, until - Date.now()));
        if (await stopped()) break;
      }
      if (await stopped()) continue;
      if (Date.now() < run.waitUntil) return pause();
    }
    if (Date.now() > deadline - 10000) return pause();

    const ct = c.contacts[run.cursor];
    const r = await sendMessage({
      to: ct.phone,
      type: c.message.type,
      text: ct.text,
      template: c.message.type === "template" ? { ...c.message.template, params: ct.params || [] } : undefined,
      media,
    });
    run.results.push({ phone: ct.phone, name: ct.name || "", status: r.ok ? "sent" : "failed", note: r.ok ? r.id || "" : r.error });
    r.ok ? run.sent++ : run.failed++;
    run.cursor++;
    if (run.cursor < run.total) {
      const batchBreak = batchSize && batchPause && run.cursor % batchSize === 0;
      run.waitUntil = Date.now() + (batchBreak ? batchPause : randomGap(c.interval));
      run.waitLabel = batchBreak ? `Batch pause after ${run.cursor} messages` : "Next message in";
    } else {
      run.waitUntil = null;
    }
    await store.set("r:" + id, run);
  }
  return finishRun(id, run);
}

const lockTtl = () => (Number.isFinite(RUN_BUDGET_MS) ? RUN_BUDGET_MS / 1000 + 60 : 7 * 86400);

// Start the next due campaign's run, or null when nothing is due
async function startNextDue() {
  const now = Date.now();
  const due = (await allCampaigns())
    .filter((c) => c.runNowRequested || (c.enabled && c.nextRunAt && now >= Date.parse(c.nextRunAt)))
    .sort((a, b) => (b.runNowRequested - a.runNowRequested) || (Date.parse(a.nextRunAt || 0) - Date.parse(b.nextRunAt || 0)));
  for (const c of due) {
    // A stopped run waits for Resume sending or Cancel; don't start another run of this campaign
    if (await store.get("r:" + c.id)) {
      if (c.runNowRequested) { c.runNowRequested = false; await store.set("c:" + c.id, c); continue; }
      const dueAt = c.nextRunAt;
      c.nextRunAt = c.schedule.type === "once" ? null : computeNext(c.schedule);
      if (c.schedule.type === "once") { c.enabled = false; c.finished = true; }
      addRun(c, `Skipped scheduled run due ${new Date(dueAt).toLocaleString("en-GB", { timeZone: c.schedule.tz || undefined })}: a stopped run is waiting (Resume sending or Cancel it)`);
      await store.set("c:" + c.id, c);
      continue;
    }
    if (c.runNowRequested) {
      c.runNowRequested = false;
      if (!apiConfigured()) { addRun(c, "Run now skipped: Cloud API not configured"); await store.set("c:" + c.id, c); continue; }
      await store.set("c:" + c.id, c);
      const run = newRun(c, "manual");
      await store.set("r:" + c.id, run);
      return { c, run };
    }
    const dueAt = c.nextRunAt;
    const late = now - Date.parse(dueAt);
    c.nextRunAt = c.schedule.type === "once" ? null : computeNext(c.schedule);
    if (c.schedule.type === "once") { c.enabled = false; c.finished = true; }
    if (late > MISSED_GRACE_MS) {
      addRun(c, `Missed run due ${new Date(dueAt).toLocaleString("en-GB", { timeZone: c.schedule.tz || undefined })} (more than ${MISSED_GRACE_MS / 3600000} h late), not sent`);
      await store.set("c:" + c.id, c);
      continue;
    }
    if (!apiConfigured()) { addRun(c, "Skipped scheduled run: Cloud API not configured"); await store.set("c:" + c.id, c); continue; }
    await store.set("c:" + c.id, c);
    const run = newRun(c, "scheduled");
    await store.set("r:" + c.id, run);
    return { c, run };
  }
  return null;
}

// Called by the cron (Vercel), every second by the local server, and after "Run now".
// Continues an unfinished run first, then sends due campaigns one after another until the time budget ends.
async function cronTick() {
  if (!store) return { ok: false, error: "no storage" };
  const deadline = Date.now() + RUN_BUDGET_MS;
  if (!(await store.lock("run", lockTtl()))) return { ok: true, result: "busy" };
  const done = [];
  try {
    for (const c of await allCampaigns()) {
      const run = await store.get("r:" + c.id);
      if (!run || run.held) continue; // held = stopped by the user, waiting for Resume sending
      const r = await processRun(c, run, deadline);
      done.push(c.name);
      if (r === "paused") return { ok: true, result: "paused", done };
    }
    while (Date.now() < deadline - 15000) {
      const next = await startNextDue();
      if (!next) break;
      const r = await processRun(next.c, next.run, deadline);
      done.push(next.c.name);
      if (r === "paused") return { ok: true, result: "paused", done };
    }
    return { ok: true, result: done.length ? "sent" : "nothing due", done };
  } catch (e) {
    log("Cron error:", e.message);
    return { ok: false, error: e.message };
  } finally {
    await store.unlock("run").catch(() => {});
  }
}

function campaignStatus(c, run) {
  return {
    id: c.id,
    name: c.name,
    enabled: c.enabled,
    finished: Boolean(c.finished),
    schedule: c.schedule,
    interval: c.interval,
    message: c.message,
    media: c.media ? { kind: c.media.kind, filename: c.media.filename, source: c.media.source } : null,
    contactsCount: c.contacts.length,
    sampleText: c.contacts[0]?.text || "",
    hasPage: Boolean(c.page),
    nextRunAt: c.enabled ? c.nextRunAt : null,
    queued: Boolean(c.runNowRequested),
    createdAt: c.createdAt,
    createdBy: c.createdBy || null,
    runs: c.runs || [],
    lastResultsCount: (c.lastResults || []).length,
    running: Boolean(run && !run.held),
    held: Boolean(run && run.held),
    progress: run && {
      total: run.total, done: run.cursor, sent: run.sent, failed: run.failed,
      waitLabel: run.waitLabel,
      waitSeconds: run.waitUntil && run.waitUntil > Date.now() ? Math.ceil((run.waitUntil - Date.now()) / 1000) : null,
      waitingForCron: Boolean(run.pausedAt),
    },
  };
}

async function listStatus() {
  const base = { apiConfigured: apiConfigured(), storage: store?.kind || null };
  if (!store) return { ...base, campaigns: [] };
  const list = await allCampaigns();
  const runs = await Promise.all(list.map((c) => store.get("r:" + c.id)));
  const stops = await Promise.all(list.map((c, i) => (runs[i] && !runs[i].held ? store.get("s:" + c.id) : null)));
  return { ...base, campaigns: list.map((c, i) => ({ ...campaignStatus(c, runs[i]), stopRequested: stops[i] || null })) };
}

// What the page showed when the campaign was saved: CSV columns and rows, message and template fields
function cleanPage(p) {
  if (!p || typeof p !== "object") return null;
  const str = (v, n = 5000) => String(v ?? "").slice(0, n);
  const headers = (Array.isArray(p.headers) ? p.headers : []).map((h) => str(h, 100)).slice(0, 50);
  const rows = (Array.isArray(p.rows) ? p.rows : []).map((r) => (Array.isArray(r) ? r : []).map((v) => str(v, 1000)).slice(0, 50));
  return { headers, rows, msg: str(p.msg, 5000), tplParams: str(p.tplParams, 2000), tplName: str(p.tplName, 200), tplLang: str(p.tplLang, 20), apiType: p.apiType === "template" ? "template" : "text", cc: str(p.cc, 5) };
}

async function handleCampaignCreate(req, res, me) {
  // Saving works without the Cloud API; sending (Start now / schedule) needs it
  let b;
  try { b = await readBody(req, onVercel ? VERCEL_BODY_LIMIT : 20e6); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON or too many contacts" }); }

  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) return sendJson(res, 400, { ok: false, error: "Give the campaign a name" });

  const s = b.schedule || {};
  if (!["once", "daily", "hours", "minutes"].includes(s.type)) return sendJson(res, 400, { ok: false, error: "Invalid schedule type" });
  if (s.type === "once" && !(Date.parse(s.at) > Date.now())) return sendJson(res, 400, { ok: false, error: "Pick a send time in the future" });
  if (s.type === "daily" && !/^\d{1,2}:\d{2}$/.test(s.time || "")) return sendJson(res, 400, { ok: false, error: "Invalid daily time" });
  if ((s.type === "hours" || s.type === "minutes") && !(Number(s.every) >= 1)) return sendJson(res, 400, { ok: false, error: "Repeat every must be at least 1" });

  const msg = b.message || {};
  if (!["text", "template"].includes(msg.type)) return sendJson(res, 400, { ok: false, error: "Invalid message type" });
  if (msg.type === "template" && !msg.template?.name) return sendJson(res, 400, { ok: false, error: "Template name missing" });

  let media = null, upload = null;
  if (b.media?.source === "upload") {
    upload = await store.get("u:" + String(b.media.uploadId || ""));
    if (!upload) return sendJson(res, 400, { ok: false, error: "Attachment upload not found; attach the file again" });
    media = { kind: upload.kind, source: "file", filename: upload.filename };
  } else if (b.media?.source === "link") {
    if (!/^https:\/\//i.test(b.media.link || "")) return sendJson(res, 400, { ok: false, error: "Attachment link must start with https://" });
    media = { kind: b.media.kind === "image" ? "image" : "document", source: "link", link: b.media.link, filename: b.media.filename || "" };
  }

  const contacts = (Array.isArray(b.contacts) ? b.contacts : [])
    .map((c) => ({ phone: String(c.phone || "").replace(/\D/g, ""), name: String(c.name || ""), text: String(c.text || ""), params: (c.params || []).map(String) }))
    .filter((c) => c.phone.length >= 8);
  if (!contacts.length) return sendJson(res, 400, { ok: false, error: "No contacts in this campaign" });
  if (msg.type === "text" && !media && contacts.some((c) => !c.text.trim())) return sendJson(res, 400, { ok: false, error: "Message is empty" });

  const iv = b.interval || {};
  const schedule = {
    type: s.type,
    time: s.time || "09:00",
    every: Number(s.every) || 1,
    at: s.type === "once" ? new Date(Date.parse(s.at)).toISOString() : null,
    tz: validTz(s.tz) ? s.tz : null,
  };
  const id = newId();
  const c = {
    id,
    name,
    enabled: true,
    finished: false,
    schedule,
    interval: { min: Number(iv.min) || 5, max: Number(iv.max) || 15, batchSize: Number(iv.batchSize) || 0, batchPause: Number(iv.batchPause) || 0 },
    message: msg.type === "template" ? { type: "template", template: { name: msg.template.name, language: msg.template.language || "en_US" } } : { type: "text" },
    media,
    contacts,
    page: cleanPage(b.page),
    nextRunAt: computeNext(schedule),
    runNowRequested: false,
    createdAt: new Date().toISOString(),
    createdBy: me?.username || null,
    runs: [],
    lastResults: [],
  };
  addRun(c, `Created with ${contacts.length} contacts`);
  if (upload) { await store.set("m:" + id, upload); await store.del("u:" + b.media.uploadId); }
  await store.set("c:" + id, c);
  await store.set("campaigns", [...(await campaignIds()), id]);
  return sendJson(res, 200, { ok: true, id, status: await listStatus() });
}

// Upload an attachment for a campaign that is about to be created
async function handleCampaignUpload(req, res) {
  let f;
  try { f = await readMediaRequest(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const uploadId = newId();
  await store.set("u:" + uploadId, { mime: f.mime, filename: f.filename, kind: f.kind, base64: f.buf.toString("base64") }, 86400);
  return sendJson(res, 200, { ok: true, uploadId, kind: f.kind, filename: f.filename });
}

async function handleCampaignAction(req, res, id, action) {
  const c = await store.get("c:" + id);
  if (!c) return sendJson(res, 404, { ok: false, error: "Campaign not found" });
  const run = await store.get("r:" + id);

  if (action === "results") return sendJson(res, 200, { ok: true, name: c.name, results: c.lastResults || [] });
  if (action === "page") {
    // Older campaigns have no saved page: rebuild a simple one from the contacts
    const page = c.page || { headers: ["phone", "name"], rows: c.contacts.map((x) => [x.phone, x.name]), msg: c.contacts[0]?.text || "", tplParams: "", tplName: c.message.template?.name || "", tplLang: c.message.template?.language || "en_US", apiType: c.message.type, cc: "" };
    return sendJson(res, 200, { ok: true, name: c.name, media: c.media ? { kind: c.media.kind, filename: c.media.filename, source: c.media.source, link: c.media.link || null } : null, page });
  }

  let startSending = false;
  if (action === "pause") {
    // Pause the schedule (no new runs); a run that is sending keeps going
    c.enabled = false;
    addRun(c, "Schedule paused");
  } else if (action === "resume") {
    // Resume the schedule
    const next = computeNext(c.schedule);
    if (!next) return sendJson(res, 400, { ok: false, error: "This one-time campaign's send time has passed. Use Start now, or create a new campaign." });
    c.enabled = true; c.finished = false; c.nextRunAt = next;
    addRun(c, "Schedule resumed");
  } else if (action === "run-now") {
    // Start a new run to every contact now (queued if another campaign is sending)
    if (run) return sendJson(res, 409, { ok: false, error: run.held ? "This campaign has a stopped run. Resume sending or Cancel it first." : "This campaign is already sending" });
    if (!apiConfigured()) return notConfigured(res);
    c.runNowRequested = true;
    addRun(c, "Start now requested");
    startSending = true;
  } else if (action === "stop") {
    // Stop sending but keep the place, so Resume sending continues with the next contact
    if (c.runNowRequested && !run) { c.runNowRequested = false; addRun(c, "Start now cancelled before it began"); }
    else if (!run || run.held) return sendJson(res, 409, { ok: false, error: "This campaign is not sending" });
    else await store.set("s:" + id, "stop");
  } else if (action === "resume-run") {
    // Continue a stopped run from the next contact
    if (!run || !run.held) return sendJson(res, 409, { ok: false, error: "There is no stopped run to resume" });
    if (!apiConfigured()) return notConfigured(res);
    run.held = false;
    run.waitUntil = null;
    await store.set("r:" + id, run);
    addRun(c, `Sending resumed from contact ${run.cursor + 1} of ${run.total}`);
    startSending = true;
  } else if (action === "cancel") {
    // Drop the rest of the run (or a queued Start now)
    if (run?.held) {
      await store.set("c:" + id, c);
      run.cancelled = true;
      await finishRun(id, run);
      return sendJson(res, 200, { ok: true, status: await listStatus() });
    }
    if (run) await store.set("s:" + id, "cancel");
    else if (c.runNowRequested) { c.runNowRequested = false; addRun(c, "Start now cancelled before it began"); }
    else return sendJson(res, 409, { ok: false, error: "Nothing to cancel" });
  } else if (action === "delete") {
    if (run && !run.held) return sendJson(res, 409, { ok: false, error: "Stop or cancel this campaign's run first" });
    await store.del("r:" + id);
    await store.del("s:" + id);
    await store.del("c:" + id);
    await store.del("m:" + id);
    await store.set("campaigns", (await campaignIds()).filter((x) => x !== id));
    log(`Campaign "${c.name}" deleted`);
    return sendJson(res, 200, { ok: true, status: await listStatus() });
  } else {
    return sendJson(res, 404, { ok: false, error: "Unknown action" });
  }
  await store.set("c:" + id, c);

  if (startSending) {
    if (onVercel) {
      // The function must stay alive while sending, so this request lasts until sending finishes or the time budget ends.
      // If another campaign is sending, this one is queued and starts after it.
      await cronTick();
    } else {
      cronTick().catch((e) => log("Run now:", e.message)); // runs in the background
      await sleep(300);
    }
  }
  return sendJson(res, 200, { ok: true, status: await listStatus() });
}

// Admin: ask Meta whether the token and phone number ID work, and show the number's details
async function handleSetupCheck(req, res, me) {
  if (me.role !== "admin") return sendJson(res, 403, { ok: false, error: "Only admins can check the setup" });
  if (!apiConfigured()) {
    return sendJson(res, 200, { ok: false, configured: false, missing: [!TOKEN && "WHATSAPP_TOKEN", !PHONE_NUMBER_ID && "WHATSAPP_PHONE_NUMBER_ID"].filter(Boolean) });
  }
  try {
    const r = await fetch(`${GRAPH_BASE}/${API_VERSION}/${encodeURIComponent(PHONE_NUMBER_ID)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = data.error || {};
      return sendJson(res, 200, { ok: false, configured: true, error: e.message || `HTTP ${r.status}`, code: e.code || null, subcode: e.error_subcode || null });
    }
    return sendJson(res, 200, {
      ok: true, configured: true,
      phone: data.display_phone_number || null, name: data.verified_name || null,
      quality: data.quality_rating || null, verification: data.code_verification_status || null,
    });
  } catch (e) {
    return sendJson(res, 200, { ok: false, configured: true, error: "Could not reach Meta: " + e.message });
  }
}

async function handleCron(req, res) {
  if (!CRON_SECRET) return sendJson(res, 503, { ok: false, error: "Set CRON_SECRET to use /api/cron" });
  if (!safeEqual(req.headers.authorization || "", `Bearer ${CRON_SECRET}`)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  return sendJson(res, 200, await cronTick());
}

// ======================= Router =======================

async function config(req) {
  // Check the database answers, so a wrong connection shows up without logging in
  let storageOk = null, storageError = null;
  if (store?.ping) {
    try { await store.ping(); storageOk = true; } catch (e) { storageOk = false; storageError = String(e.message || e).slice(0, 200); }
  }
  let me = null;
  try { me = await currentUser(req); } catch { /* database down: treated as logged out */ }
  return {
    apiConfigured: apiConfigured(),
    phoneNumberId: PHONE_NUMBER_ID ? "…" + PHONE_NUMBER_ID.slice(-4) : null,
    platform: onVercel ? "vercel" : "local",
    authRequired,
    authMisconfigured,
    loggedIn: Boolean(me),
    user: me,
    accounts: Boolean(store), // user accounts (Users tab) need a database
    storage: store?.kind || null,
    redisConfigured,
    postgresConfigured,
    storageOk,
    storageError,
    cronConfigured: Boolean(CRON_SECRET),
    maxUpload: { image: maxUpload("image"), document: maxUpload("document") },
  };
}

// Handles /api/* requests. Returns false for other paths.
async function handleApi(req, res, pathname) {
  if (!pathname.startsWith("/api/")) return false;
  const m = req.method;
  try {
    if (m === "GET" && pathname === "/api/config") return sendJson(res, 200, await config(req)), true;
    if (m === "POST" && pathname === "/api/login") return await handleLogin(req, res), true;
    if (m === "POST" && pathname === "/api/logout") return handleLogout(req, res), true;
    if ((m === "GET" || m === "POST") && pathname === "/api/cron") return await handleCron(req, res), true;
    // Forgot password (no login needed)
    if (m === "POST" && pathname === "/api/reset/request") return await handleResetRequest(req, res), true;
    if (m === "POST" && pathname === "/api/reset/status") return await handleResetComplete(req, res, false), true;
    if (m === "POST" && pathname === "/api/reset/complete") return await handleResetComplete(req, res, true), true;

    const me = await currentUser(req);
    if (!me) {
      sendJson(res, 401, { ok: false, error: authMisconfigured ? "Set APP_PASSWORD in Vercel, then redeploy." : "Please log in" });
      return true;
    }
    if (m === "GET" && pathname === "/api/me") return sendJson(res, 200, { ok: true, user: me }), true;
    if (m === "POST" && pathname === "/api/me/password") return await handleChangePassword(req, res, me), true;
    // After an admin reset or a recovery login, nothing else works until a new password is set
    if (me.mustChange) return sendJson(res, 403, { ok: false, mustChange: true, error: "Set a new password first" }), true;
    if (m === "GET" && pathname === "/api/users/requests") return await handleUsers(req, res, me, "requests"), true;
    const um = pathname.match(/^\/api\/users(?:\/([a-z0-9._-]{3,32})\/(reset|role|delete|approve-reset|decline-reset))?$/);
    if (um && (m === "GET" || m === "POST")) return await handleUsers(req, res, me, um[1], um[2]), true;
    if (m === "GET" && pathname === "/api/setup/check") return await handleSetupCheck(req, res, me), true;
    if (m === "POST" && pathname === "/api/send") return await handleSend(req, res), true;
    if (m === "POST" && pathname === "/api/upload") return await handleUpload(req, res), true;

    if (pathname.startsWith("/api/campaigns") && !store) return noStore(res), true;
    if (m === "GET" && pathname === "/api/campaigns") return sendJson(res, 200, await listStatus()), true;
    if (m === "POST" && pathname === "/api/campaigns") return await handleCampaignCreate(req, res, me), true;
    if (m === "POST" && pathname === "/api/campaigns/upload") return await handleCampaignUpload(req, res), true;
    const act = pathname.match(/^\/api\/campaigns\/([a-f0-9]{12})\/(pause|resume|run-now|stop|resume-run|cancel|delete|results|page)$/);
    if (act && (m === "POST" || (m === "GET" && (act[2] === "results" || act[2] === "page")))) return await handleCampaignAction(req, res, act[1], act[2]), true;

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    log("API error:", e.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
  }
  return true;
}

module.exports = { handleApi, cronTick, apiConfigured, buildPayload, computeNext, store, log, authRequired, campaignIds };
