// Vercel serverless function: every /api/* request is rewritten here (see vercel.json).
// The page itself is served from public/ as static files.
const { handleApi } = require("../lib/app");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  // vercel.json rewrites /api/<path> to /api/index?path=<path>; otherwise use the original path
  const sub = url.searchParams.get("path");
  const pathname = url.pathname.startsWith("/api/index") && sub ? "/api/" + sub : url.pathname;
  const handled = await handleApi(req, res, pathname);
  if (!handled) {
    res.statusCode = 404;
    res.end("Not found");
  }
};
