// scripts/agent-dump.js — Use JSDOM-like fetch to render the page server-side is
// not possible (DOM + canvas). Instead, we just download the page + the
// bundled CSS to inspect the raw styles & structure.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.resolve(__dirname, "..", "tmp");
await fs.mkdir(tmpDir, { recursive: true });

const html = await fetch("http://localhost:3417/agent.html").then((r) => r.text());
await fs.writeFile(path.join(tmpDir, "agent-page.html"), html, "utf8");

// Extract CSS link
const cssMatch = html.match(/href="\.\/(assets\/agent-[^"]+\.css)"/);
if (cssMatch) {
  const css = await fetch(`http://localhost:3417/${cssMatch[1]}`).then((r) => r.text());
  await fs.writeFile(path.join(tmpDir, "agent.css"), css, "utf8");
  console.log("CSS saved:", cssMatch[1], css.length, "bytes");
}

// Extract JS link
const jsMatch = html.match(/src="\.\/(assets\/agent-[^"]+\.js)"/);
if (jsMatch) {
  console.log("JS bundle:", jsMatch[1]);
}

console.log("HTML saved to", path.join(tmpDir, "agent-page.html"));
console.log("HTML length:", html.length);
