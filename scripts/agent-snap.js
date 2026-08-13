// scripts/agent-snap.js — Playwright snapshot of the agent page.
import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "..", "tmp", "agent-snap.png");

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});

await page.goto("http://localhost:4173/agent.html", { waitUntil: "networkidle" });
await page.waitForTimeout(500);
await page.screenshot({ path: out, fullPage: false });
console.log("snapshot saved:", out);
if (errors.length) console.log("PAGE ERRORS:\n" + errors.join("\n"));
else console.log("no page errors");
await browser.close();
