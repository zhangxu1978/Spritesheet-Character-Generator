// Current selections component
import m from "mithril";
import type { CatalogReader } from "../../state/catalog.ts";
import { state } from "../../state/state.ts";
import {
  isItemLicenseCompatible,
  isItemAnimationCompatible,
} from "../../state/filters.ts";
import { translateItem } from "../../i18n.ts";

type CurrentSelectionsAttrs = {
  catalog: CatalogReader;
};

export const CurrentSelections: m.Component<CurrentSelectionsAttrs> = {
  view(vnode) {
    const { catalog } = vnode.attrs;
    if (!catalog.isLiteReady()) {
      return m("div", [
        m("h3.title.is-5", "当前选择"),
        m("p.is-size-7.has-text-grey", "正在加载物品列表…"),
      ]);
    }

    const selectionCount = Object.keys(state.selections).length;

    if (selectionCount === 0) {
      return m("div", [
        m("h3.title.is-5", "当前选择"),
        m("p.has-text-grey", "尚未选择任何物品"),
      ]);
    }

    const creditsReady = catalog.isCreditsReady();

    return m("div", [
      m("h3.title.is-5", "当前选择"),
      m(
        "div.tags",
        Object.entries(state.selections).map(([selectionKey, selection]) => {
          const isLicenseCompatible = isItemLicenseCompatible(
            selection.itemId,
            catalog,
          );
          const isAnimCompatible = isItemAnimationCompatible(
            selection.itemId,
            catalog,
          );
          const isCompatible = isLicenseCompatible && isAnimCompatible;
          const metaResult = catalog.getItemMerged(selection.itemId);
          const meta = metaResult.isOk() ? metaResult.value : null;

          const allLicenses = new Set<string>();
          if (meta) {
            for (const credit of meta.credits) {
              for (const lic of credit.licenses) {
                allLicenses.add(lic.trim());
              }
            }
          }
          const licensesText = !creditsReady
            ? "许可信息加载中…"
            : allLicenses.size > 0
              ? `许可：${Array.from(allLicenses).join(", ")}`
              : "无许可信息";

          const supportedAnims = meta?.animations ?? [];
          const animsText =
            supportedAnims.length > 0
              ? `动画：${supportedAnims.join(", ")}`
              : "无动画信息";

          let tooltipText = "";
          if (!isCompatible) {
            const issues: string[] = [];
            if (!isLicenseCompatible) issues.push("许可");
            if (!isAnimCompatible) issues.push("动画");
            tooltipText = `⚠️ 与所选${issues.join("和")}不兼容\n`;
          }
          tooltipText += `${licensesText}\n${animsText}`;

          return m(
            "span.tag.is-medium",
            {
              key: selectionKey,
              class: isCompatible ? "is-info" : "is-warning",
              title: creditsReady ? tooltipText : undefined,
            },
            [
              m("span", translateItem(selection.name)),
              !isCompatible ? m("span.ml-1", "⚠️") : null,
              m("button.delete.is-small", {
                onclick: () => {
                  delete state.selections[selectionKey];
                },
              }),
            ],
          );
        }),
      ),
    ]);
  },
};
