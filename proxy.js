const http = require("http");
const https = require("https");

const PORT = Number(process.argv[2]) || 8080;
const TARGET = "generativelanguage.googleapis.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (!req.url.startsWith("/v1beta/")) {
    res.writeHead(404, { ...CORS, "Content-Type": "text/plain" });
    res.end("cont Gemini proxy — forward /v1beta/* to Google");
    return;
  }

  const proxyReq = https.request(
    {
      hostname: TARGET,
      path: req.url,
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        "Content-Length": req.headers["content-length"],
      },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        ...CORS,
        "Content-Type": proxyRes.headers["content-type"] || "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", (err) => {
    res.writeHead(502, { ...CORS, "Content-Type": "text/plain" });
    res.end("Proxy error: " + err.message);
  });

  req.pipe(proxyReq);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`cont Gemini proxy on http://localhost:${PORT}`);
  console.log("Paste cont on CSP-locked pages; requests auto-fallback here.");
});
