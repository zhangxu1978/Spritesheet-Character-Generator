// scripts/agent-driver.js — Drive Chrome via CDP to load the page, fill the
// composer, submit, wait for the assistant + image, then screenshot.
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import fs from "node:fs/promises";

const PORT = 9223;
const url = "http://localhost:4173/agent.html";

// Launch Chrome with remote debugging
const chrome = spawn(
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${process.env.TEMP}\\chrome-agent-${Date.now()}`,
    "--window-size=1440,900",
    url,
  ],
  { stdio: "ignore", detached: true },
);
chrome.unref();

// Wait for CDP
let target = null;
for (let i = 0; i < 30; i++) {
  await wait(300);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      target = await r.json();
      break;
    }
  } catch {}
}
if (!target) {
  console.error("Chrome CDP did not come up");
  process.exit(1);
}

// Find the page target (not the about:blank one)
const tabs = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
const pageTab = tabs.find((t) => t.type === "page");
if (!pageTab) {
  console.error("No page target found");
  process.exit(1);
}

const wsUrl = pageTab.webSocketDebuggerUrl;
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.on("message", (data) => {
  const m = JSON.parse(data.toString());
  if (m.id != null && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method) {
    events.push(m);
  }
});
function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Wait for the page to be idle
await wait(2500);

// Type prompt into the textarea and submit
const typeResult = await send("Runtime.evaluate", {
  expression: `
    (() => {
      const ta = document.querySelector('.chat-panel__textarea');
      if (!ta) return 'no-textarea';
      ta.value = '给我一个穿蓝袍子拿法杖的女法师，演示施法动作';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const form = ta.closest('.chat-panel');
      const btn = form.querySelector('.chat-panel__send');
      btn.click();
      return 'sent';
    })()
  `,
  awaitPromise: false,
  returnByValue: true,
});
console.log("type:", typeResult.result?.result?.value);

// Wait for assistant + image
for (let i = 0; i < 30; i++) {
  await wait(1000);
  const r = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const img = document.querySelector('.agent-preview__canvas');
        const has = img && img.width > 100 && img.height > 0;
        const toolCount = document.querySelectorAll('.chat-tool').length;
        const lastAssistant = document.querySelector('.chat-msg--assistant .chat-msg__bubble');
        return JSON.stringify({ has, toolCount, assistant: lastAssistant?.textContent?.trim().slice(0, 80) });
      })()
    `,
    returnByValue: true,
  });
  const v = JSON.parse(r.result?.result?.value ?? "{}");
  console.log("tick", i, v);
  if (v.has && v.toolCount > 0) break;
}

// Final screenshot via CDP
const screenshot = await send("Page.captureScreenshot", { format: "png" });
await fs.writeFile("tmp/agent-with-image.png", Buffer.from(screenshot.result.data, "base64"));
console.log("screenshot saved tmp/agent-with-image.png");

ws.close();
try {
  process.kill(chrome.pid, "SIGKILL");
} catch {}
process.exit(0);
