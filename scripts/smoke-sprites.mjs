// scripts/smoke-sprites.mjs — 模拟"原方式 N 个 PNG" vs "bundle 后单端点列表"
// 用法: node scripts/smoke-sprites.mjs [baseUrl]
import http from "node:http";

const base = process.argv[2] ?? "http://localhost:3417";

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
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
  });
}

(async () => {
  // 1) 拿 bundle 列表
  const r = await get("/api/bundle/default");
  const list = JSON.parse(r.body.toString("utf8"));
  const sprites = list.sprites;
  console.log(
    `bundle list: ${sprites.length} sprites, ` +
      `total ${Object.values(list.sizes).reduce((a, b) => a + b, 0)} bytes`,
  );

  // 2) 模拟"前端直接 N 次拉 PNG"(每个 PNG 单独 HTTP 请求)
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(
    sprites.map((s) => get(`/spritesheets/${s.path}`)),
  );
  const dtN = Number(process.hrtime.bigint() - t0) / 1e6;
  const totalBytes = results.reduce((a, r) => a + r.body.length, 0);
  console.log(
    `N×PNG fetch  : ${dtN.toFixed(2)}ms  (${sprites.length} requests, ` +
      `${totalBytes}B transferred, ` +
      `avg ${(dtN / sprites.length).toFixed(2)}ms/op)`,
  );

  // 3) 第二次访问(模拟"HTTP/2 multiplex + 浏览器缓存复用"),warm
  const t1 = process.hrtime.bigint();
  const results2 = await Promise.all(
    sprites.map((s) => get(`/spritesheets/${s.path}`)),
  );
  const dtN2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`N×PNG warm   : ${dtN2.toFixed(2)}ms`);

  // 4) 模拟"bundle 列表 + 一次性触发 N 个 fetch"(和浏览器一样)
  const t2 = process.hrtime.bigint();
  const list2 = await get("/api/bundle/default");
  await Promise.all(
    JSON.parse(list2.body.toString("utf8")).sprites.map((s) =>
      get(`/spritesheets/${s.path}`),
    ),
  );
  const dtB = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log(
    `bundle+N PNG : ${dtB.toFixed(2)}ms  (1 list + ${sprites.length} PNG, ` +
      `${dtB < dtN ? "saved " + (dtN - dtB).toFixed(2) + "ms" : "slower"})`,
  );

  // 5) 仅"bundle 列表"的成本(只多一个请求,PNG 已经浏览器缓存了)
  const t3 = process.hrtime.bigint();
  const r3 = await get("/api/bundle/default");
  const dtList = Number(process.hrtime.bigint() - t3) / 1e6;
  console.log(`bundle only  : ${dtList.toFixed(2)}ms  (${r3.status})`);
})();