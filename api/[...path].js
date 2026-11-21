// Vercel serverless function: the [...path] file name makes Vercel send every /api/* request here
// with the original URL. The page itself is served from public/ as static files.
const { handleApi } = require("../lib/app");

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname = url.pathname;
  // Fallback in case a rewrite points at the function file itself and passes the path as ?path=
  const sub = url.searchParams.get("path");
  if (sub && /^\/api\/(index|\[\.\.\.path\])(\.js)?$/.test(pathname)) pathname = "/api/" + sub;
  pathname = pathname.replace(/\/+$/, "");
  const handled = await handleApi(req, res, pathname);
  if (!handled) {
    res.statusCode = 404;
    res.end("Not found");
  }
};
