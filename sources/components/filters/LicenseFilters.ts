// License Filters component
import m from "mithril";
import { state } from "../../state/state.ts";
import type { CatalogReader } from "../../state/catalog.ts";
import { isItemLicenseCompatible } from "../../state/filters.ts";
import { LICENSE_CONFIG } from "../../state/constants.ts";

type LicenseOption = {
  key: string;
  label: string;
  url?: string;
  urlLabel?: string;
};
type LicenseFiltersDeps = {
  isItemLicenseCompatible: typeof isItemLicenseCompatible;
  licenseConfig: readonly LicenseOption[];
};

// Dependency injection for testability
const deps: LicenseFiltersDeps = {
  isItemLicenseCompatible,
  licenseConfig: LICENSE_CONFIG,
};

export function setLicenseCompatible(
  overrides: Pick<LicenseFiltersDeps, "isItemLicenseCompatible">,
): void {
  deps.isItemLicenseCompatible = overrides.isItemLicenseCompatible;
}
export function isLicenseCompatible(
  itemId: string,
  catalog: CatalogReader,
): boolean {
  return deps.isItemLicenseCompatible(itemId, catalog);
}

export function setLicenseConfig(config: readonly LicenseOption[]): void {
  deps.licenseConfig = config;
}
export function getLicenseConfig(): readonly LicenseOption[] {
  return deps.licenseConfig;
}

type LicenseFiltersState = { isExpanded: boolean };
type LicenseFiltersAttrs = {
  catalog: CatalogReader;
};

export const LicenseFilters: m.Component<
  LicenseFiltersAttrs,
  LicenseFiltersState
> = {
  oninit(vnode) {
    vnode.state.isExpanded = false;
  },
  view(vnode) {
    const liteReady = vnode.attrs.catalog.isLiteReady();

    const removeIncompatibleItems = () => {
      const toRemove: string[] = [];
      for (const [selectionGroup, selection] of Object.entries(
        state.selections,
      )) {
        if (!isLicenseCompatible(selection.itemId, vnode.attrs.catalog)) {
          toRemove.push(selectionGroup);
        }
      }

      if (toRemove.length > 0) {
        toRemove.forEach((key) => delete state.selections[key]);
        alert(`已移除 ${toRemove.length} 个不兼容的物品`);
      } else {
        alert("未发现不兼容物品");
      }
    };

    const creditsReady = vnode.attrs.catalog.isCreditsReady();

    const incompatibleSelections = creditsReady
      ? Object.values(state.selections).filter(
          (selection) =>
            !isLicenseCompatible(selection.itemId, vnode.attrs.catalog),
        )
      : [];
    const hasIncompatibleItems =
      creditsReady && incompatibleSelections.length > 0;

    const enabledCount = Object.values(state.enabledLicenses).filter(
      Boolean,
    ).length;
    const totalCount = getLicenseConfig().length;

    return m("div.box.mb-4.has-background-light", [
      m(
        "div.tree-label",
        {
          onclick: () => {
            vnode.state.isExpanded = !vnode.state.isExpanded;
          },
        },
        [
          m("span.tree-arrow", {
            class: vnode.state.isExpanded ? "expanded" : "collapsed",
          }),
          m("span.title.is-6.is-inline", "许可协议筛选"),
          m(
            "span.is-size-7.has-text-grey.ml-2",
            `(已启用 ${enabledCount}/${totalCount})`,
          ),
        ],
      ),
      vnode.state.isExpanded
        ? m("div.content.mt-3", [
            !liteReady
              ? m("p.is-size-7.has-text-grey.mb-3", "正在加载物品列表…")
              : null,
            !creditsReady
              ? m(
                  "p.is-size-7.has-text-grey.mb-3",
                  "正在加载资产许可数据…",
                )
              : null,
            m(
              "ul.tree-list",
              getLicenseConfig().map((license) =>
                m("li", { key: license.key, class: "mb-2" }, [
                  m("label.checkbox", [
                    m("input[type=checkbox]", {
                      checked: state.enabledLicenses[license.key],
                      disabled: !liteReady,
                      onchange: (e: Event) => {
                        const target = e.target as HTMLInputElement;
                        state.enabledLicenses[license.key] = target.checked;
                      },
                    }),
                    ` ${license.label} `,
                    m(
                      "a.is-size-7",
                      {
                        href: license.url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      `(查看许可${license.urlLabel ? " " + license.urlLabel : ""})`,
                    ),
                  ]),
                ]),
              ),
            ),
            hasIncompatibleItems
              ? [
                  m("div.notification.is-warning.is-light.p-3.mt-2", [
                    m("p.is-size-7", [
                      m(
                        "strong",
                        `${incompatibleSelections.length} 个已选物品与当前许可选择不兼容`,
                      ),
                      m("span.has-text-grey", "（上方以 ⚠️ 标记）"),
                    ]),
                  ]),
                  m(
                    "button.button.is-small.is-warning.mt-2",
                    {
                      onclick: removeIncompatibleItems,
                      title: `移除 ${incompatibleSelections.length} 个不兼容物品`,
                    },
                    `移除 ${incompatibleSelections.length} 个不兼容资产`,
                  ),
                ]
              : null,
          ])
        : null,
    ]);
  },
};
