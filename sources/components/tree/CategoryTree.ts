// Main tree component
import m from "mithril";
import {
  state,
  resetAll,
  getSelectionGroup,
  applyMatchBodyColor,
} from "../../state/state.ts";
import type {
  CatalogReader,
  CategoryTree as CategoryTreeShape,
} from "../../state/catalog.ts";
import { renderResult } from "../../utils/render-result.ts";
import { BodyTypeSelector } from "./BodyTypeSelector.ts";
import { TreeNode } from "./TreeNode.ts";

type CategoryTreeAttrs = { catalog: CatalogReader };

function renderLoadingHost() {
  return m("div.box.has-background-light.category-tree-panel", [
    m("div.category-tree-loading-host", [
      m(
        "div.category-tree-loading-overlay",
        { "aria-busy": "true", "aria-live": "polite" },
        m("span.loading", { "aria-label": "正在加载类别索引" }),
      ),
      m("h3.title.is-5.mb-3", "可用物品"),
      m("p.has-text-grey.is-size-7", "正在加载类别索引…"),
    ]),
  ]);
}

function renderTree(categoryTree: CategoryTreeShape, catalog: CatalogReader) {
  const liteReady = catalog.isLiteReady();

  return m("div.box.has-background-light.category-tree-panel", [
    m(
      "div.is-flex.is-justify-content-space-between.is-align-items-center.mb-3",
      [
        m("h3.title.is-5.mb-0", "可用物品"),
        m("div.buttons.mb-0", [
          m(
            "button.button.is-danger.is-small",
            { onclick: resetAll },
            "重置全部",
          ),
          m(
            "button.button.is-small",
            {
              onclick: () => {
                state.expandedNodes = {};
              },
            },
            "全部折叠",
          ),
          m(
            "button.button.is-small",
            {
              disabled: !liteReady,
              title: liteReady ? undefined : "正在加载物品列表…",
              onclick: () => {
                if (!liteReady) return;
                for (const [, selection] of Object.entries(state.selections)) {
                  const { itemId } = selection;
                  catalog.getItemMerged(itemId).match(
                    (meta) => {
                      let pathSoFar = "";
                      // Expand all path segments (categories)
                      for (const segment of meta.path) {
                        pathSoFar = pathSoFar
                          ? `${pathSoFar}-${segment}`
                          : segment;
                        state.expandedNodes[pathSoFar] = true;
                      }
                      // Also expand the item itself (to show variants)
                      state.expandedNodes[itemId] = true;
                    },
                    () => {
                      // Selection points at an unknown id (stale URL or
                      // mid-load). Skip — nothing to expand.
                    },
                  );
                }
              },
            },
            "展开已选",
          ),
          m(
            "button.button.is-small",
            {
              class: state.compactDisplay ? "is-link" : "",
              onclick: () => {
                state.compactDisplay = !state.compactDisplay;
              },
            },
            "紧凑显示",
          ),
        ]),
      ],
    ),
    m("div.mb-3", [
      m(
        "label.checkbox",
        {
          title:
            "启用后，修改身体颜色将自动把所有兼容物品（头部、耳朵、鼻子等）更新为相同的颜色变体",
        },
        [
          m("input[type=checkbox]", {
            id: "match-body-color-checkbox",
            "aria-describedby": "match-body-color-label",
            checked: state.matchBodyColorEnabled,
            onchange: (e: Event) => {
              const target = e.target as HTMLInputElement;
              state.matchBodyColorEnabled = target.checked;
              // If enabling the checkbox, immediately apply match body color
              if (target.checked) {
                // Use body-body as the source if available
                const bodySelectionGroup = getSelectionGroup("body-body");
                const bodySelection = state.selections[bodySelectionGroup];
                if (bodySelection?.variant) {
                  applyMatchBodyColor(
                    bodySelection.variant,
                    bodySelection.recolor ?? bodySelection.variant,
                  );
                }
              }
            },
          }),
          " 匹配身体颜色",
        ],
      ),
      m(
        "p.is-size-7.has-text-grey.mt-1.ml-4",
        {
          id: "match-body-color-label",
        },
        "身体颜色变化时自动更新头部、耳朵及其他物品",
      ),
    ]),
    m("div", [
      // Body Type as first tree item
      m(BodyTypeSelector),
      // Rest of the category tree
      Object.entries(categoryTree.children ?? {}).map(
        ([categoryName, categoryNode]) =>
          m(TreeNode, {
            key: categoryName,
            name: categoryName,
            node: categoryNode,
            catalog,
          }),
      ),
    ]),
  ]);
}

export const CategoryTree: m.Component<CategoryTreeAttrs> = {
  view(vnode) {
    const { catalog } = vnode.attrs;
    return renderResult(
      catalog.getCategoryTree(),
      (categoryTree) => renderTree(categoryTree, catalog),
      () => renderLoadingHost(),
    );
  },
};
