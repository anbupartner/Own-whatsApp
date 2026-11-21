// Shared app logic used by both the local server (server.js) and the Vercel function (api/[...path].js).
const crypto = require("crypto");
const { store, redisConfigured, onVercel } = require("./store");

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

// ======================= Login =======================
// With APP_PASSWORD set, every API call except /api/config and /api/login needs a session cookie.
// On Vercel the app is public, so it refuses to work until APP_PASSWORD is set.

const authRequired = Boolean(APP_PASSWORD) || onVercel;
const authMisconfigured = onVercel && !APP_PASSWORD;
const SESSION_DAYS = 30;
const sessionKey = crypto.createHash("sha256").update("wa-session:" + APP_PASSWORD).digest();
const sign = (s) => crypto.createHmac("sha256", sessionKey).update(s).digest("base64url");

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function getCookie(req, name) {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function isLoggedIn(req) {
  if (!authRequired) return true;
  if (authMisconfigured) return false;
  const v = getCookie(req, "wa_session");
  if (!v) return false;
  const [exp, sig] = v.split(".");
  return Number(exp) > Date.now() && sig && safeEqual(sig, sign(exp));
}

function cookieAttrs(req) {
  const secure = onVercel || req.headers["x-forwarded-proto"] === "https";
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

async function handleLogin(req, res) {
  if (authMisconfigured) return sendJson(res, 503, { ok: false, error: "Set the APP_PASSWORD environment variable in Vercel, then redeploy." });
  if (!authRequired) return sendJson(res, 200, { ok: true });
  let b;
  try { b = await readBody(req); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }
  if (!safeEqual(b.password || "", APP_PASSWORD)) {
    await sleep(700); // slow down guessing
    return sendJson(res, 401, { ok: false, error: "Wrong password" });
  }
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return sendJson(res, 200, { ok: true }, {
    "Set-Cookie": `wa_session=${exp}.${sign(exp)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`,
  });
}

function handleLogout(req, res) {
  sendJson(res, 200, { ok: true }, { "Set-Cookie": `wa_session=; Max-Age=0; ${cookieAttrs(req)}` });
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

// Next run time (ISO) after `from`
function computeNext(schedule, from = Date.now()) {
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

// ======================= Server-side schedule =======================
// Stored keys: job (the saved broadcast), media (attachment file), run (a run in progress), stop (stop request)
// job = { enabled, schedule:{type,time,every,tz}, interval:{min,max,batchSize,batchPause},
//         message:{type,template?}, media:{kind,source,link?,filename}|null, contacts:[{phone,name,text,params}],
//         nextRunAt, savedAt, runs:[{at,text}], lastResults:[...] }

const noStore = (res) => sendJson(res, 503, {
  ok: false,
  error: onVercel ? "No database connected. Add Upstash Redis to the Vercel project (Storage tab), then redeploy." : "Storage not available",
});

function addRun(job, text) {
  job.runs = [{ at: new Date().toISOString(), text }, ...(job.runs || [])].slice(0, 20);
  log("Schedule:", text);
}

function randomGap(interval) {
  let a = Math.max(1, Number(interval.min) || 1);
  let b = Math.max(1, Number(interval.max) || a);
  if (b < a) [a, b] = [b, a];
  return (a + Math.random() * (b - a)) * 1000;
}

const newRun = (job, trigger) => ({
  trigger, startedAt: new Date().toISOString(), cursor: 0, total: job.contacts.length,
  sent: 0, failed: 0, results: [], mediaId: null, waitUntil: null, waitLabel: null, pausedAt: null,
});

async function finishRun(run, note) {
  const job = await store.get("job"); // re-read: it may have been paused/resumed meanwhile
  if (job) {
    const name = run.trigger === "scheduled" ? "Scheduled" : "Manual";
    addRun(job, note
      ? `${name} run failed: ${note}`
      : `${name} run${run.stopped ? " (stopped)" : ""}: sent ${run.sent}, failed ${run.failed} of ${run.total}`);
    job.lastResults = run.results;
    await store.set("job", job);
  }
  await store.del("run");
  await store.del("stop");
  return "finished";
}

// Send the run's remaining messages until done, stopped, or the time budget is used up.
async function processRun(job, run, deadline) {
  run.pausedAt = null;
  const stopped = async () => (await store.get("stop")) === true;

  let media = null;
  if (job.media?.source === "file") {
    if (!run.mediaId) {
      const m = await store.get("media");
      if (!m) return finishRun(run, "attachment file missing");
      const up = await uploadMedia(Buffer.from(m.base64, "base64"), m.mime, m.filename);
      if (!up.ok) return finishRun(run, "attachment upload failed: " + up.error);
      run.mediaId = up.id;
      await store.set("run", run);
    }
    media = { kind: job.media.kind, id: run.mediaId, filename: job.media.filename };
  } else if (job.media?.source === "link") {
    media = { kind: job.media.kind, link: job.media.link, filename: job.media.filename };
  }

  const batchSize = Math.max(0, Number(job.interval.batchSize) || 0);
  const batchPause = Math.max(0, Number(job.interval.batchPause) || 0) * 1000;

  while (run.cursor < run.total) {
    if (await stopped()) { run.stopped = true; return finishRun(run); }

    // Wait out the gap, checking for Stop and the time budget
    if (run.waitUntil && Date.now() < run.waitUntil) {
      const until = Math.min(run.waitUntil, deadline - 5000);
      while (Date.now() < until) {
        await sleep(Math.min(store.kind === "redis" ? 2000 : 500, until - Date.now()));
        if (await stopped()) break;
      }
      if (await stopped()) continue;
      if (Date.now() < run.waitUntil) { run.pausedAt = new Date().toISOString(); await store.set("run", run); return "paused"; }
    }
    if (Date.now() > deadline - 10000) { run.pausedAt = new Date().toISOString(); await store.set("run", run); return "paused"; }

    const c = job.contacts[run.cursor];
    const r = await sendMessage({
      to: c.phone,
      type: job.message.type,
      text: c.text,
      template: job.message.type === "template" ? { ...job.message.template, params: c.params || [] } : undefined,
      media,
    });
    run.results.push({ phone: c.phone, name: c.name || "", status: r.ok ? "sent" : "failed", note: r.ok ? r.id || "" : r.error });
    r.ok ? run.sent++ : run.failed++;
    run.cursor++;
    if (run.cursor < run.total) {
      const batchBreak = batchSize && batchPause && run.cursor % batchSize === 0;
      run.waitUntil = Date.now() + (batchBreak ? batchPause : randomGap(job.interval));
      run.waitLabel = batchBreak ? `Batch pause after ${run.cursor} messages` : "Next message in";
    } else {
      run.waitUntil = null;
    }
    await store.set("run", run);
  }
  return finishRun(run);
}

const lockTtl = () => (Number.isFinite(RUN_BUDGET_MS) ? RUN_BUDGET_MS / 1000 + 60 : 7 * 86400);

// Called by the cron (Vercel), or every second by the local server
async function cronTick() {
  if (!store) return { ok: false, error: "no storage" };
  const deadline = Date.now() + RUN_BUDGET_MS;
  if (!(await store.lock("run", lockTtl()))) return { ok: true, result: "busy" };
  try {
    const job = await store.get("job");
    if (!job) return { ok: true, result: "no schedule" };
    let run = await store.get("run");
    if (!run) {
      if (!job.enabled || !job.nextRunAt || Date.now() < Date.parse(job.nextRunAt)) return { ok: true, result: "not due" };
      const late = Date.now() - Date.parse(job.nextRunAt);
      const dueAt = job.nextRunAt;
      job.nextRunAt = computeNext(job.schedule);
      if (late > MISSED_GRACE_MS) {
        addRun(job, `Missed run due ${new Date(dueAt).toLocaleString("en-GB", { timeZone: job.schedule.tz || undefined })} (more than ${MISSED_GRACE_MS / 3600000} h late), not sent`);
        await store.set("job", job);
        return { ok: true, result: "missed" };
      }
      if (!apiConfigured()) {
        addRun(job, "Skipped scheduled run: Cloud API not configured");
        await store.set("job", job);
        return { ok: true, result: "skipped" };
      }
      await store.set("job", job);
      run = newRun(job, "scheduled");
      await store.set("run", run);
    }
    return { ok: true, result: await processRun(job, run, deadline) };
  } catch (e) {
    log("Cron error:", e.message);
    return { ok: false, error: e.message };
  } finally {
    await store.unlock("run").catch(() => {});
  }
}

async function runNow() {
  const deadline = Date.now() + RUN_BUDGET_MS;
  if (!(await store.lock("run", lockTtl()))) return { ok: false, error: "Already sending" };
  try {
    const job = await store.get("job");
    if (!job) return { ok: false, error: "No schedule saved" };
    if (await store.get("run")) return { ok: false, error: "A run is already in progress" };
    if (!apiConfigured()) return { ok: false, error: "Cloud API not configured" };
    const run = newRun(job, "manual");
    await store.set("run", run);
    return { ok: true, result: await processRun(job, run, deadline) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await store.unlock("run").catch(() => {});
  }
}

async function jobStatus() {
  const base = { apiConfigured: apiConfigured(), storage: store?.kind || null };
  if (!store) return { ...base, exists: false };
  const [job, run] = await Promise.all([store.get("job"), store.get("run")]);
  if (!job) return { ...base, exists: false, running: Boolean(run) };
  return {
    ...base,
    exists: true,
    enabled: job.enabled,
    schedule: job.schedule,
    interval: job.interval,
    message: job.message,
    media: job.media ? { kind: job.media.kind, filename: job.media.filename, source: job.media.source } : null,
    contactsCount: job.contacts.length,
    nextRunAt: job.enabled ? job.nextRunAt : null,
    savedAt: job.savedAt,
    runs: job.runs || [],
    lastResults: job.lastResults || [],
    running: Boolean(run),
    progress: run && {
      total: run.total, done: run.cursor, sent: run.sent, failed: run.failed,
      waitLabel: run.waitLabel,
      waitSeconds: run.waitUntil && run.waitUntil > Date.now() ? Math.ceil((run.waitUntil - Date.now()) / 1000) : null,
      waitingForCron: Boolean(run.pausedAt),
    },
  };
}

async function handleScheduleSave(req, res) {
  if (!apiConfigured()) return notConfigured(res);
  if (await store.get("run")) return sendJson(res, 409, { ok: false, error: "A run is in progress. Stop it or wait, then save again." });
  let b;
  try { b = await readBody(req, onVercel ? VERCEL_BODY_LIMIT : 20e6); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON or too many contacts" }); }

  const s = b.schedule || {};
  if (!["daily", "hours", "minutes"].includes(s.type)) return sendJson(res, 400, { ok: false, error: "Invalid schedule type" });
  if (s.type === "daily" && !/^\d{1,2}:\d{2}$/.test(s.time || "")) return sendJson(res, 400, { ok: false, error: "Invalid daily time" });
  if (s.type !== "daily" && !(Number(s.every) >= 1)) return sendJson(res, 400, { ok: false, error: "Repeat every must be at least 1" });

  const msg = b.message || {};
  if (!["text", "template"].includes(msg.type)) return sendJson(res, 400, { ok: false, error: "Invalid message type" });
  if (msg.type === "template" && !msg.template?.name) return sendJson(res, 400, { ok: false, error: "Template name missing" });

  let media = null;
  if (b.media?.source === "file") {
    const m = await store.get("media");
    if (!m) return sendJson(res, 400, { ok: false, error: "Attachment file was not uploaded to the server" });
    media = { kind: m.kind, source: "file", filename: m.filename };
  } else if (b.media?.source === "link") {
    if (!/^https:\/\//i.test(b.media.link || "")) return sendJson(res, 400, { ok: false, error: "Attachment link must start with https://" });
    media = { kind: b.media.kind === "image" ? "image" : "document", source: "link", link: b.media.link, filename: b.media.filename || "" };
  }

  const contacts = (Array.isArray(b.contacts) ? b.contacts : [])
    .map((c) => ({ phone: String(c.phone || "").replace(/\D/g, ""), name: String(c.name || ""), text: String(c.text || ""), params: (c.params || []).map(String) }))
    .filter((c) => c.phone.length >= 8);
  if (!contacts.length) return sendJson(res, 400, { ok: false, error: "No contacts to schedule" });
  if (msg.type === "text" && !media && contacts.some((c) => !c.text.trim())) return sendJson(res, 400, { ok: false, error: "Message is empty" });

  const iv = b.interval || {};
  const schedule = { type: s.type, time: s.time || "09:00", every: Number(s.every) || 1, tz: validTz(s.tz) ? s.tz : null };
  const old = await store.get("job");
  const job = {
    enabled: true,
    schedule,
    interval: { min: Number(iv.min) || 5, max: Number(iv.max) || 15, batchSize: Number(iv.batchSize) || 0, batchPause: Number(iv.batchPause) || 0 },
    message: msg.type === "template" ? { type: "template", template: { name: msg.template.name, language: msg.template.language || "en_US" } } : { type: "text" },
    media,
    contacts,
    nextRunAt: computeNext(schedule),
    savedAt: new Date().toISOString(),
    runs: old?.runs || [],
    lastResults: [],
  };
  if (!media) await store.del("media");
  addRun(job, `Schedule saved: ${contacts.length} contacts`);
  await store.set("job", job);
  return sendJson(res, 200, { ok: true, status: await jobStatus() });
}

async function handleScheduleMedia(req, res) {
  let f;
  try { f = await readMediaRequest(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  await store.set("media", { mime: f.mime, filename: f.filename, kind: f.kind, base64: f.buf.toString("base64") });
  return sendJson(res, 200, { ok: true, kind: f.kind, filename: f.filename });
}

async function handleScheduleAction(req, res, action) {
  const job = await store.get("job");
  if (!job) return sendJson(res, 404, { ok: false, error: "No schedule saved" });
  if (action === "pause" || action === "resume") {
    job.enabled = action === "resume";
    if (job.enabled) job.nextRunAt = computeNext(job.schedule);
    addRun(job, job.enabled ? "Resumed" : "Paused");
    await store.set("job", job);
  } else if (action === "run-now") {
    if (await store.get("run")) return sendJson(res, 409, { ok: false, error: "A run is already in progress" });
    if (onVercel) {
      // The function must stay alive while sending, so this request lasts until the run finishes or the time budget ends
      const r = await runNow();
      if (!r.ok) return sendJson(res, 409, r);
    } else {
      runNow().then((r) => { if (!r.ok) log("Run now:", r.error); }); // runs in the background
      await sleep(300);
    }
  } else if (action === "stop") {
    if (!(await store.get("run"))) return sendJson(res, 409, { ok: false, error: "Nothing is sending" });
    await store.set("stop", true);
  } else if (action === "delete") {
    if (await store.get("run")) return sendJson(res, 409, { ok: false, error: "Stop the current run first" });
    await store.del("job");
    await store.del("media");
    log("Schedule deleted");
  }
  return sendJson(res, 200, { ok: true, status: await jobStatus() });
}

async function handleCron(req, res) {
  if (!CRON_SECRET) return sendJson(res, 503, { ok: false, error: "Set CRON_SECRET to use /api/cron" });
  if (!safeEqual(req.headers.authorization || "", `Bearer ${CRON_SECRET}`)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });
  return sendJson(res, 200, await cronTick());
}

// ======================= Router =======================

function config(req) {
  return {
    apiConfigured: apiConfigured(),
    phoneNumberId: PHONE_NUMBER_ID ? "…" + PHONE_NUMBER_ID.slice(-4) : null,
    platform: onVercel ? "vercel" : "local",
    authRequired,
    authMisconfigured,
    loggedIn: isLoggedIn(req),
    storage: store?.kind || null,
    redisConfigured,
    cronConfigured: Boolean(CRON_SECRET),
    maxUpload: { image: maxUpload("image"), document: maxUpload("document") },
  };
}

// Handles /api/* requests. Returns false for other paths.
async function handleApi(req, res, pathname) {
  if (!pathname.startsWith("/api/")) return false;
  const m = req.method;
  try {
    if (m === "GET" && pathname === "/api/config") return sendJson(res, 200, config(req)), true;
    if (m === "POST" && pathname === "/api/login") return await handleLogin(req, res), true;
    if (m === "POST" && pathname === "/api/logout") return handleLogout(req, res), true;
    if ((m === "GET" || m === "POST") && pathname === "/api/cron") return await handleCron(req, res), true;

    if (!isLoggedIn(req)) {
      sendJson(res, 401, { ok: false, error: authMisconfigured ? "Set APP_PASSWORD in Vercel, then redeploy." : "Please log in" });
      return true;
    }
    if (m === "POST" && pathname === "/api/send") return await handleSend(req, res), true;
    if (m === "POST" && pathname === "/api/upload") return await handleUpload(req, res), true;

    if (pathname.startsWith("/api/schedule") && !store) return noStore(res), true;
    if (m === "GET" && pathname === "/api/schedule") return sendJson(res, 200, await jobStatus()), true;
    if (m === "POST" && pathname === "/api/schedule") return await handleScheduleSave(req, res), true;
    if (m === "POST" && pathname === "/api/schedule/media") return await handleScheduleMedia(req, res), true;
    const act = pathname.match(/^\/api\/schedule\/(pause|resume|run-now|stop|delete)$/);
    if (m === "POST" && act) return await handleScheduleAction(req, res, act[1]), true;

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    log("API error:", e.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
  }
  return true;
}

module.exports = { handleApi, cronTick, apiConfigured, buildPayload, computeNext, store, log, authRequired };
