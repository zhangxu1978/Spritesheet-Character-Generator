// scripts/smoke-bundle.mjs — quick curl-style smoke test using Node's http
// 用法: node scripts/smoke-bundle.mjs [baseUrl]
import http from "node:http";

const base = process.argv[2] ?? "http://localhost:4173";

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

function fmt(label, r) {
  const sz = r.body?.length ?? 0;
  console.log(
    `${label}: HTTP ${r.status}  ${r.headers.etag ?? "no-etag"}  ${sz}B`,
  );
}

(async () => {
  console.log(`base = ${base}\n`);

  // 1) healthz
  fmt("healthz         ", await get("/api/healthz"));

  // 2) bundle first
  const r1 = await get("/api/bundle/default");
  fmt("bundle (cold)   ", r1);

  // 3) bundle with ETag → expect 304
  const etag = r1.headers.etag;
  if (etag) {
    const r2 = await get("/api/bundle/default", { "If-None-Match": etag });
    fmt("bundle (warm)   ", r2);
  }

  // 4) bundle with Last-Modified → expect 304
  const lm = r1.headers["last-modified"];
  if (lm) {
    const r3 = await get("/api/bundle/default", { "If-Modified-Since": lm });
    fmt("bundle (If-Mod) ", r3);
  }

  // 5) metadata/all
  const r4 = await get("/api/metadata/all");
  fmt("metadata (cold) ", r4);
  const r5 = await get("/api/metadata/all", {
    "If-None-Match": r4.headers.etag ?? "",
  });
  fmt("metadata (warm) ", r5);

  // 6) timing — average over 5 calls
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    await get("/api/bundle/default");
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(dt);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`\nbundle avg latency (5x): ${avg.toFixed(2)}ms`);
  console.log(`bundle cold: ${times[0].toFixed(2)}ms  warm: ${avg.toFixed(2)}ms`);
})();