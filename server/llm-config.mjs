// llm-config.mjs — load agent/LLM config from project-root config.json.
//
// Rules:
//   - Read once, cached in module scope.
//   - Missing file → return null and let the caller fall back to "echo".
//   - Partial file (missing fields) → still return a usable object where
//     possible, otherwise null.
//   - Never throws (server should keep running on misconfigured dev setups).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// server/ lives at the project root, so ../config.json is the target.
const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");

let cached = null;
let warnedMissing = false;

export function loadConfig() {
  if (cached) return cached;
  if (!fs.existsSync(CONFIG_PATH)) {
    if (!warnedMissing) {
      console.warn(`[agent] config.json not found at ${CONFIG_PATH}; falling back to echo mode`);
      warnedMissing = true;
    }
    cached = null;
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    console.warn(`[agent] failed to parse config.json: ${e.message}; falling back to echo mode`);
    cached = null;
    return null;
  }
  const a = raw?.agent;
  if (!a || typeof a !== "object") {
    cached = null;
    return null;
  }
  if (!a.apiKey || !a.baseUrl || !a.model) {
    // Partial config — treat as missing so the echo fallback kicks in.
    if (!warnedMissing) {
      console.warn(`[agent] config.json missing agent.apiKey/baseUrl/model; falling back to echo mode`);
      warnedMissing = true;
    }
    cached = null;
    return null;
  }
  cached = {
    provider: a.provider ?? "MiniMax",
    apiKey: a.apiKey,
    model: a.model,
    baseUrl: a.baseUrl.replace(/\/$/, ""),
    temperature: typeof a.temperature === "number" ? a.temperature : 0.1,
  };
  return cached;
}

export function isProviderEnabled(providerName) {
  const cfg = loadConfig();
  return cfg?.provider === providerName;
}

export function resetConfigCacheForTests() {
  cached = null;
  warnedMissing = false;
}