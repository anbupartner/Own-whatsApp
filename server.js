// Simple WhatsApp bulk sender - local server (no dependencies, Node 18+)
// Serves the web page, forwards "API mode" sends to the WhatsApp Cloud API,
// and runs the repeating broadcast schedule (saved in data/ so it survives restarts).
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- load .env (simple KEY=VALUE parser) ----
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith("#")) {
      process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const API_VERSION = process.env.GRAPH_API_VERSION || "v21.0";
const GRAPH_BASE = (process.env.GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, "");
const apiConfigured = () => Boolean(TOKEN && PHONE_NUMBER_ID);

const DATA_DIR = path.join(__dirname, "data");
const JOB_FILE = path.join(DATA_DIR, "schedule.json");
const MEDIA_FILE = path.join(DATA_DIR, "schedule-media.bin");
const MEDIA_META = path.join(DATA_DIR, "schedule-media.json");

function log(...a) { console.log(new Date().toLocaleString(), "-", ...a); }

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================= WhatsApp Cloud API =======================

// WhatsApp media limits (bytes) and allowed types
const MEDIA_RULES = {
  image: { max: 5 * 1024 * 1024, types: ["image/jpeg", "image/png"] },
  document: { max: 100 * 1024 * 1024, types: null }, // any common document type
};
const mediaKind = (mime) => (MEDIA_RULES.image.types.includes(mime) ? "image" : "document");

// Media object for a message: uploaded id, or a public https link
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
    // Image or document, with the message text as its caption
    const obj = mediaObject(media);
    if (text && text.trim()) obj.caption = text;
    return { messaging_product: "whatsapp", recipient_type: "individual", to, type: media.kind, [media.kind]: obj };
  }
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: true, body: text } };
}

// Send one message. Returns { ok, id } or { ok:false, error }
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

// Upload a file to WhatsApp. Returns { ok, id } or { ok:false, error }
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

// Read an uploaded file from the request after checking type and size
async function readMediaRequest(req) {
  const mime = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
  const filename = decodeURIComponent(String(req.headers["x-filename"] || "file"));
  const kind = mediaKind(mime);
  if (mime.startsWith("image/") && kind !== "image") throw new Error("Images must be JPEG or PNG");
  let buf;
  try { buf = await readRaw(req, MEDIA_RULES[kind].max); }
  catch (e) { throw new Error(`${e.message} (max ${MEDIA_RULES[kind].max / 1024 / 1024} MB for ${kind}s)`); }
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

async function handleSend(req, res) {
  if (!apiConfigured()) return sendJson(res, 400, { ok: false, error: "API not configured. Fill in .env and restart the server." });
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

// Upload a file once; the returned media id is reused for every contact.
async function handleUpload(req, res) {
  if (!apiConfigured()) return sendJson(res, 400, { ok: false, error: "API not configured. Fill in .env and restart the server." });
  let f;
  try { f = await readMediaRequest(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  const r = await uploadMedia(f.buf, f.mime, f.filename);
  return sendJson(res, 200, r.ok ? { ...r, kind: f.kind, filename: f.filename } : r);
}

// ======================= Server-side schedule =======================
// One saved broadcast job:
// { enabled, schedule:{type,time,every}, interval:{min,max,batchSize,batchPause},
//   message:{type,template?:{name,language}}, media:{kind,source:"file"|"link",link?,filename,mime?}|null,
//   contacts:[{phone,name,text,params}], nextRunAt, runs:[...], lastResults:[...] }

let job = null;
let running = false;
let stopRequested = false;
let progress = null; // { total, done, sent, failed, waitUntil, waitLabel }

function loadJob() {
  try { job = JSON.parse(fs.readFileSync(JOB_FILE, "utf8")); } catch { job = null; }
}
function saveJob() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (job) fs.writeFileSync(JOB_FILE, JSON.stringify(job, null, 2));
  else fs.rmSync(JOB_FILE, { force: true });
}
function addRun(text) {
  job.runs = [{ at: new Date().toISOString(), text }, ...(job.runs || [])].slice(0, 20);
  log("Schedule:", text);
}

// Next run time after `from`, in this computer's local time
function computeNext(schedule, from = new Date()) {
  if (schedule.type === "daily") {
    const [h, m] = String(schedule.time || "09:00").split(":").map(Number);
    const t = new Date(from); t.setHours(h, m, 0, 0);
    if (t <= from) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  const n = Math.max(1, Number(schedule.every) || 1);
  return new Date(from.getTime() + n * (schedule.type === "hours" ? 3600000 : 60000)).toISOString();
}

function randomGap(interval) {
  let a = Math.max(1, Number(interval.min) || 1);
  let b = Math.max(1, Number(interval.max) || a);
  if (b < a) [a, b] = [b, a];
  return (a + Math.random() * (b - a)) * 1000;
}

// Wait that ends early when Stop is pressed
async function stoppableWait(ms, label) {
  progress.waitUntil = Date.now() + ms;
  progress.waitLabel = label;
  while (!stopRequested && Date.now() < progress.waitUntil) await sleep(Math.min(250, progress.waitUntil - Date.now()));
  progress.waitUntil = null;
  progress.waitLabel = null;
}

async function runJob(trigger) {
  if (running) { addRun(`Skipped ${trigger} run: previous run still sending`); saveJob(); return; }
  if (!apiConfigured()) { addRun(`Skipped ${trigger} run: Cloud API not configured`); saveJob(); return; }
  running = true;
  stopRequested = false;
  const { contacts, interval, message } = job;
  progress = { total: contacts.length, done: 0, sent: 0, failed: 0 };
  const results = [];
  try {
    // A saved file is uploaded fresh each run (WhatsApp media ids expire after 30 days)
    let media = null;
    if (job.media?.source === "file") {
      const meta = JSON.parse(fs.readFileSync(MEDIA_META, "utf8"));
      const up = await uploadMedia(fs.readFileSync(MEDIA_FILE), meta.mime, meta.filename);
      if (!up.ok) { addRun(`${trigger} run failed: attachment upload failed: ${up.error}`); return; }
      media = { kind: job.media.kind, id: up.id, filename: meta.filename };
    } else if (job.media?.source === "link") {
      media = { kind: job.media.kind, link: job.media.link, filename: job.media.filename };
    }

    const batchSize = Math.max(0, Number(interval.batchSize) || 0);
    const batchPause = Math.max(0, Number(interval.batchPause) || 0) * 1000;
    for (let k = 0; k < contacts.length && !stopRequested; k++) {
      const c = contacts[k];
      const r = await sendMessage({
        to: c.phone,
        type: message.type,
        text: c.text,
        template: message.type === "template" ? { ...message.template, params: c.params || [] } : undefined,
        media,
      });
      results.push({ phone: c.phone, name: c.name || "", status: r.ok ? "sent" : "failed", note: r.ok ? r.id || "" : r.error });
      progress.done++;
      r.ok ? progress.sent++ : progress.failed++;
      if (k < contacts.length - 1 && !stopRequested) {
        if (batchSize && batchPause && (k + 1) % batchSize === 0) await stoppableWait(batchPause, `Batch pause after ${k + 1} messages`);
        else await stoppableWait(randomGap(interval), "Next message in");
      }
    }
    addRun(`${trigger[0].toUpperCase() + trigger.slice(1)} run${stopRequested ? " (stopped)" : ""}: sent ${progress.sent}, failed ${progress.failed} of ${contacts.length}`);
  } catch (e) {
    addRun(`${trigger} run error: ${e.message}`);
  } finally {
    if (job) { job.lastResults = results; saveJob(); }
    running = false;
    progress = null;
  }
}

// Check once per second whether a run is due
function tick() {
  if (!job || !job.enabled || !job.nextRunAt) return;
  if (Date.now() >= Date.parse(job.nextRunAt)) {
    job.nextRunAt = computeNext(job.schedule);
    saveJob();
    runJob("scheduled");
  }
}

function jobStatus() {
  if (!job) return { exists: false, running, apiConfigured: apiConfigured() };
  return {
    exists: true,
    apiConfigured: apiConfigured(),
    enabled: job.enabled,
    schedule: job.schedule,
    interval: job.interval,
    message: job.message,
    media: job.media ? { kind: job.media.kind, filename: job.media.filename, source: job.media.source } : null,
    contactsCount: job.contacts.length,
    sample: job.contacts[0] ? { phone: job.contacts[0].phone, text: job.contacts[0].text, params: job.contacts[0].params } : null,
    nextRunAt: job.enabled ? job.nextRunAt : null,
    savedAt: job.savedAt,
    runs: job.runs || [],
    lastResults: job.lastResults || [],
    running,
    progress: progress && { ...progress, waitSeconds: progress.waitUntil ? Math.ceil((progress.waitUntil - Date.now()) / 1000) : null },
  };
}

async function handleScheduleSave(req, res) {
  if (!apiConfigured()) return sendJson(res, 400, { ok: false, error: "Cloud API not configured. Fill in .env and restart the server." });
  if (running) return sendJson(res, 409, { ok: false, error: "A run is sending right now. Stop it or wait, then save again." });
  let b;
  try { b = await readBody(req, 20e6); } catch { return sendJson(res, 400, { ok: false, error: "Invalid JSON" }); }

  const s = b.schedule || {};
  if (!["daily", "hours", "minutes"].includes(s.type)) return sendJson(res, 400, { ok: false, error: "Invalid schedule type" });
  if (s.type === "daily" && !/^\d{1,2}:\d{2}$/.test(s.time || "")) return sendJson(res, 400, { ok: false, error: "Invalid daily time" });
  if (s.type !== "daily" && !(Number(s.every) >= 1)) return sendJson(res, 400, { ok: false, error: "Repeat every must be at least 1" });

  const msg = b.message || {};
  if (!["text", "template"].includes(msg.type)) return sendJson(res, 400, { ok: false, error: "Invalid message type" });
  if (msg.type === "template" && !msg.template?.name) return sendJson(res, 400, { ok: false, error: "Template name missing" });

  let media = null;
  if (b.media?.source === "file") {
    if (!fs.existsSync(MEDIA_FILE) || !fs.existsSync(MEDIA_META)) return sendJson(res, 400, { ok: false, error: "Attachment file was not uploaded to the server" });
    const meta = JSON.parse(fs.readFileSync(MEDIA_META, "utf8"));
    media = { kind: meta.kind, source: "file", filename: meta.filename, mime: meta.mime };
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
  const schedule = { type: s.type, time: s.time || "09:00", every: Number(s.every) || 1 };
  job = {
    enabled: true,
    schedule,
    interval: { min: Number(iv.min) || 5, max: Number(iv.max) || 15, batchSize: Number(iv.batchSize) || 0, batchPause: Number(iv.batchPause) || 0 },
    message: msg.type === "template" ? { type: "template", template: { name: msg.template.name, language: msg.template.language || "en_US" } } : { type: "text" },
    media,
    contacts,
    nextRunAt: computeNext(schedule),
    savedAt: new Date().toISOString(),
    runs: job?.runs || [],
    lastResults: [],
  };
  if (!media && fs.existsSync(MEDIA_FILE)) { fs.rmSync(MEDIA_FILE, { force: true }); fs.rmSync(MEDIA_META, { force: true }); }
  addRun(`Schedule saved: ${contacts.length} contacts, next run ${new Date(job.nextRunAt).toLocaleString()}`);
  saveJob();
  return sendJson(res, 200, { ok: true, status: jobStatus() });
}

async function handleScheduleMedia(req, res) {
  let f;
  try { f = await readMediaRequest(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEDIA_FILE, f.buf);
  fs.writeFileSync(MEDIA_META, JSON.stringify({ mime: f.mime, filename: f.filename, kind: f.kind }));
  return sendJson(res, 200, { ok: true, kind: f.kind, filename: f.filename });
}

async function handleScheduleAction(req, res, action) {
  if (!job) return sendJson(res, 404, { ok: false, error: "No schedule saved" });
  if (action === "pause" || action === "resume") {
    job.enabled = action === "resume";
    if (job.enabled) job.nextRunAt = computeNext(job.schedule);
    addRun(job.enabled ? `Resumed, next run ${new Date(job.nextRunAt).toLocaleString()}` : "Paused");
    saveJob();
  } else if (action === "run-now") {
    if (running) return sendJson(res, 409, { ok: false, error: "Already sending" });
    runJob("manual"); // runs in the background
  } else if (action === "stop") {
    stopRequested = true;
  } else if (action === "delete") {
    if (running) return sendJson(res, 409, { ok: false, error: "Stop the current run first" });
    job = null;
    saveJob();
    fs.rmSync(MEDIA_FILE, { force: true });
    fs.rmSync(MEDIA_META, { force: true });
    log("Schedule deleted");
  } else {
    return sendJson(res, 404, { ok: false, error: "Unknown action" });
  }
  return sendJson(res, 200, { ok: true, status: jobStatus() });
}

// ======================= HTTP server =======================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/api/config") {
    return sendJson(res, 200, {
      apiConfigured: apiConfigured(),
      phoneNumberId: PHONE_NUMBER_ID ? "…" + PHONE_NUMBER_ID.slice(-4) : null,
      apiVersion: API_VERSION,
    });
  }
  if (req.method === "POST" && p === "/api/send") return handleSend(req, res);
  if (req.method === "POST" && p === "/api/upload") return handleUpload(req, res);
  if (req.method === "GET" && p === "/api/schedule") return sendJson(res, 200, jobStatus());
  if (req.method === "POST" && p === "/api/schedule") return handleScheduleSave(req, res);
  if (req.method === "POST" && p === "/api/schedule/media") return handleScheduleMedia(req, res);
  const act = p.match(/^\/api\/schedule\/(pause|resume|run-now|stop|delete)$/);
  if (req.method === "POST" && act) return handleScheduleAction(req, res, act[1]);

  if (req.method === "GET") {
    const file = p === "/" ? "index.html" : p.slice(1);
    const full = path.join(__dirname, "public", path.normalize(file));
    if (!full.startsWith(path.join(__dirname, "public"))) return sendJson(res, 403, { error: "Forbidden" });
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".csv": "text/csv" };
      res.writeHead(200, { "Content-Type": types[path.extname(full)] || "application/octet-stream" });
      return fs.createReadStream(full).pipe(res);
    }
  }
  sendJson(res, 404, { error: "Not found" });
});

// Load the saved schedule. Runs missed while the server was off are not sent late.
loadJob();
if (job?.enabled && job.nextRunAt && Date.parse(job.nextRunAt) <= Date.now()) {
  addRun(`Missed run at ${new Date(job.nextRunAt).toLocaleString()} (server was off), not sent`);
  job.nextRunAt = computeNext(job.schedule);
  saveJob();
}
setInterval(tick, 1000);

// Listen on localhost only - the token never leaves this machine except to Meta.
server.listen(PORT, "127.0.0.1", () => {
  log(`WhatsApp sender running at http://localhost:${PORT}`);
  log(apiConfigured() ? "Cloud API: configured" : "Cloud API: NOT configured (manual link mode still works)");
  if (job) log(`Schedule: ${job.enabled ? "active, next run " + new Date(job.nextRunAt).toLocaleString() : "paused"} (${job.contacts.length} contacts)`);
});
