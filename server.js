// Local server: serves the page from public/ and the API from lib/app.js.
// Run with: npm start   (on Vercel, api/[...path].js is used instead)
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---- load .env (simple KEY=VALUE parser) before the app reads process.env ----
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith("#")) {
      process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const { handleApi, cronTick, apiConfigured, store, log, authRequired, campaignIds } = require("./lib/app");

const PORT = Number(process.env.PORT || 3000);
// Listen on localhost only unless HOST is set (e.g. HOST=0.0.0.0 on a VPS, together with APP_PASSWORD)
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".csv": "text/csv", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleApi(req, res, url.pathname)) return;

  if (req.method === "GET") {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream" });
      return fs.createReadStream(full).pipe(res);
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

if (HOST !== "127.0.0.1" && HOST !== "localhost" && !authRequired) {
  console.error("Refusing to listen on", HOST, "without APP_PASSWORD set: anyone on the network could send messages with your token.");
  process.exit(1);
}

// Check the schedule every second (on Vercel, /api/cron does this instead)
setInterval(() => { cronTick().catch((e) => log("Schedule error:", e.message)); }, 1000);

server.listen(PORT, HOST, async () => {
  log(`WhatsApp sender running at http://localhost:${PORT}`);
  log(apiConfigured() ? "Cloud API: configured" : "Cloud API: NOT configured (manual link mode still works)");
  log(`Storage: ${store.kind}${authRequired ? ", password login on" : ""}`);
  const ids = await campaignIds();
  log(`Campaigns: ${ids.length}`);
});
