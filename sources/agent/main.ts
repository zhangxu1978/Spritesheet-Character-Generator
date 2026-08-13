// Agent main — entry point for the Agent page (agent.html). Mirrors the
// bootstrap shape of sources/main.ts but mounts only the AgentApp.

import m from "mithril";
import "../styles/agent.scss";
import { AgentApp } from "./AgentApp.ts";
import { loadAllMetadata } from "../install-item-metadata.ts";

document.addEventListener("DOMContentLoaded", () => {
  // Fire-and-forget; the AgentApp renders immediately and the session will
  // catch up once catalog metadata registers.
  void loadAllMetadata();
  const mount = document.getElementById("mithril-agent");
  if (!mount) {
    console.error("mithril-agent mount point missing");
    return;
  }
  mount.classList.remove("loading");
  // Mirror the boot pattern from sources/main.ts: m.mount(root, { view: () =>
  // m(Component, attrs) }) so the wrapper carries the real attrs object that
  // AgentApp.oninit expects.
  m.mount(mount, {
    view: () => m(AgentApp),
  });

  // 后端 bundle 可用时,提前预热默认 sprite — 用户首次提交"渲染角色"
  // 命令时不再被 N 个 PNG 串行加载阻塞。
  void (async () => {
    try {
      const { fetchSpriteList, preloadSprites, DEFAULT_CHARACTER_ID } =
        await import("../state/bundle-source.ts");
      const list = await fetchSpriteList(DEFAULT_CHARACTER_ID);
      if (list && list.length > 0) {
        await preloadSprites(list);
      }
    } catch {
      /* 后端不可用时静默忽略 */
    }
  })();
});