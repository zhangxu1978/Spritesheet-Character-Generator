// Search control component
import m from "mithril";
import type { CatalogReader } from "../../state/catalog.ts";
import { state } from "../../state/state.ts";

type SearchControlAttrs = {
  catalog: CatalogReader;
};

export const SearchControl: m.Component<SearchControlAttrs> = {
  view(vnode) {
    const liteReady = vnode.attrs.catalog.isLiteReady();
    return m("div.field", [
      m("label.label", "搜索："),
      m("input.input[type=search][placeholder=搜索]", {
        value: state.searchQuery,
        disabled: !liteReady,
        title: liteReady ? undefined : "正在加载物品列表…",
        oninput: (e: Event) => {
          state.searchQuery = (e.target as HTMLInputElement).value;
        },
      }),
    ]);
  },
};
