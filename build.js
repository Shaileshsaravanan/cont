const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "ai.js");
const outDir = path.join(__dirname, "dist");
const out = path.join(outDir, "cont.js");

let code = fs.readFileSync(src, "utf8");

if (process.argv.includes("--minify")) {
  code = code
    .replace(/\/\*\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(out, code);
console.log("Wrote", out, `(${code.length} bytes)`);
