// Download component
import m from "mithril";
import { state } from "../../state/state.ts";
import { drawCalls } from "../../canvas/renderer.ts";
import {
  getAllCredits,
  creditsToCsv,
  creditsToTxt,
} from "../../utils/credits.ts";
import { CollapsibleSection } from "../CollapsibleSection.ts";
import { downloadFile, downloadAsPNG } from "../../canvas/download.ts";
import {
  importStateFromJSON,
  exportStateAsJSON,
  serializeLayersForJson,
} from "../../state/json.ts";
import {
  exportSplitAnimations,
  exportSplitItemSheets,
  exportSplitItemAnimations,
  exportIndividualFrames,
} from "../../state/zip.ts";
import { debugLog } from "../../utils/debug.ts";
import type { CatalogReader } from "../../state/catalog.ts";

const zipExportTitle = "请等待图层数据加载完成";

export const Download: m.Component<{ catalog: CatalogReader }> = {
  view(vnode) {
    const zipDisabled = !vnode.attrs.catalog.isLayersReady();

    const exportToClipboard = async (): Promise<void> => {
      if (!window.canvasRenderer) return;
      try {
        const json = exportStateAsJSON(
          vnode.attrs.catalog,
          state,
          serializeLayersForJson(drawCalls),
        );
        debugLog(json);
        await navigator.clipboard.writeText(json);
        alert("已导出到剪贴板！");
      } catch (err) {
        console.error("Failed to copy to clipboard:", err);
        alert("复制到剪贴板失败，请检查浏览器权限。");
      }
    };

    const importFromClipboard = async (): Promise<void> => {
      if (!window.canvasRenderer) return;
      try {
        const json = await navigator.clipboard.readText();
        debugLog(json);
        const imported = importStateFromJSON(json);
        Object.assign(state, imported);

        m.redraw();
        alert("导入成功！");
      } catch (err) {
        console.error("Failed to import from clipboard:", err);
        alert("导入失败，请检查剪贴板内容和浏览器权限。");
      }
    };

    const saveAsPNG = () => {
      if (!window.canvasRenderer) return;
      downloadAsPNG("character-spritesheet.png");
    };

    return m(
      CollapsibleSection,
      {
        title: "下载",
        defaultOpen: true,
      },
      [
        m("div.buttons.is-flex.is-flex-wrap-wrap", { id: "download-buttons" }, [
          m(
            "button.button.is-small.is-primary",
            { onclick: saveAsPNG },
            "精灵表 (PNG)",
          ),
          m(
            "button.button.is-small",
            {
              onclick: () => {
                const allCredits = getAllCredits(
                  vnode.attrs.catalog,
                  state.selections,
                  state.bodyType,
                );
                const txtContent = creditsToTxt(allCredits);
                downloadFile(txtContent, "credits.txt", "text/plain");
              },
            },
            "署名 (TXT)",
          ),
          m(
            "button.button.is-small",
            {
              onclick: () => {
                const allCredits = getAllCredits(
                  vnode.attrs.catalog,
                  state.selections,
                  state.bodyType,
                );
                const csvContent = creditsToCsv(allCredits);
                downloadFile(csvContent, "credits.csv", "text/csv");
              },
            },
            "署名 (CSV)",
          ),
          m(
            "button.button.is-small.is-info",
            {
              disabled: zipDisabled,
              title: zipDisabled ? zipExportTitle : undefined,
              onclick: exportSplitAnimations,
            },
            "ZIP：按动画拆分",
          ),
          state.zipByAnimation.isRunning ? m("span.loading") : null,
          m(
            "button.button.is-small.is-info",
            {
              disabled: zipDisabled,
              title: zipDisabled ? zipExportTitle : undefined,
              onclick: exportSplitItemSheets,
            },
            "ZIP：按物品拆分",
          ),
          state.zipByItem.isRunning ? m("span.loading") : null,
          m(
            "button.button.is-small.is-info",
            {
              disabled: zipDisabled,
              title: zipDisabled ? zipExportTitle : undefined,
              onclick: exportSplitItemAnimations,
            },
            "ZIP：按动画与物品拆分",
          ),
          state.zipByAnimationAndItem.isRunning ? m("span.loading") : null,
          m(
            "button.button.is-small.is-info",
            {
              disabled: zipDisabled,
              title: zipDisabled ? zipExportTitle : undefined,
              onclick: exportIndividualFrames,
            },
            "ZIP：按动画与帧拆分",
          ),
          state.zipIndividualFrames && state.zipIndividualFrames.isRunning
            ? m("span.loading")
            : null,
          m(
            "button.button.is-small.is-link",
            { onclick: exportToClipboard },
            "导出到剪贴板 (JSON)",
          ),
          m(
            "button.button.is-small.is-link",
            { onclick: importFromClipboard },
            "从剪贴板导入 (JSON)",
          ),
        ]),
      ],
    );
  },
};
