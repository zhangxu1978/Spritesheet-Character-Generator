// scripts/agent-safelist-test.js — minimal PurgeCSS dry run.
import { PurgeCSS } from "purgecss";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const css = await fs.readFile(
  path.join(repoRoot, "sources", "styles", "agent.scss"),
  "utf8",
);

const result = await new PurgeCSS().purge({
  content: [
    path.join(repoRoot, "index.html"),
    path.join(repoRoot, "agent.html"),
    path.join(repoRoot, "sources", "**", "*.{js,ts}"),
  ],
  css: [{ raw: css }],
});

const out = result[0]?.css ?? "";
console.log("input  bytes:", css.length);
console.log("output bytes:", out.length);
console.log("ratio:        ", ((out.length / css.length) * 100).toFixed(1) + "%");
// Print which class names survived
const survived = new Set();
for (const m of out.matchAll(/\.([a-zA-Z_][\w-]*)/g)) survived.add(m[1]);
console.log("surviving classes:", survived.size);
console.log([...survived].sort().join("\n"));
