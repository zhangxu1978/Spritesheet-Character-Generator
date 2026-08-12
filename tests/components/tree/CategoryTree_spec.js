import m from "mithril";
import { assert } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha-globals";
import { CategoryTree } from "../../../sources/components/tree/CategoryTree.ts";
import { state } from "../../../sources/state/state.ts";
import {
  defaultCatalog,
  resetCatalogForTests,
  registerFromIndexModule,
  registerFromPaletteModule,
} from "../../../sources/state/catalog.ts";
import { BODY_TYPES } from "../../../sources/state/constants.ts";
import { resetState } from "../../../sources/state/filters.ts";
import {
  restoreAppCatalogAfterTest,
  seedBrowserCatalog,
} from "../../browser-catalog-fixture.js";

describe("CategoryTree", function () {
  let host;

  beforeEach(function () {
    resetState();
    state.expandedNodes = {};
    state.searchQuery = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(async function () {
    m.render(host, null);
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
    resetState();
    await restoreAppCatalogAfterTest();
  });

  it("shows loading panel until the category index is ready", function () {
    resetCatalogForTests();

    m.render(host, m(CategoryTree, { catalog: defaultCatalog }));

    assert.ok(host.querySelector(".category-tree-loading-overlay"));
    assert.strictEqual(
      host
        .querySelector(".category-tree-loading-overlay")
        .getAttribute("aria-busy"),
      "true",
    );
    assert.include(host.textContent, "可用物品");
    assert.include(host.textContent, "正在加载类别索引…");
    assert.strictEqual(host.querySelector("button"), null);
  });

  it("disables Expand Selected while the item list (lite) is not ready", function () {
    resetCatalogForTests();
    registerFromIndexModule({
      aliasMetadata: {},
      categoryTree: { items: [], children: {} },
      metadataIndexes: {
        byTypeName: {},
        hashMatch: { itemsByTypeName: {} },
      },
    });
    registerFromPaletteModule({
      paletteMetadata: { versions: {}, materials: {} },
    });

    m.render(host, m(CategoryTree, { catalog: defaultCatalog }));

    const expandBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "展开已选",
    );
    assert.notEqual(expandBtn, null);
    assert.isTrue(expandBtn.disabled);
    assert.strictEqual(expandBtn.getAttribute("title"), "正在加载物品列表…");
  });

  it("renders toolbar, match-body-color control, body selector, and category items", function () {
    seedBrowserCatalog(
      {
        ct_hat_1: {
          name: "Category Tree Hat",
          type_name: "hat",
          required: [...BODY_TYPES],
          animations: ["walk"],
          credits: [],
          layers: {},
          path: ["Gear"],
        },
      },
      {
        categoryTree: {
          items: [],
          children: {
            Gear: { items: ["ct_hat_1"], children: {} },
          },
        },
      },
    );
    state.expandedNodes.Gear = true;

    m.render(host, m(CategoryTree, { catalog: defaultCatalog }));

    assert.strictEqual(
      host.querySelector("h3.title")?.textContent?.trim(),
      "可用物品",
    );

    const labels = [...host.querySelectorAll("button")].map((b) =>
      b.textContent.trim(),
    );
    assert.includeMembers(labels, [
      "重置全部",
      "全部折叠",
      "展开已选",
      "紧凑显示",
    ]);

    const expandSelected = [...host.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "展开已选",
    );
    assert.isFalse(expandSelected.disabled);

    const matchCb = host.querySelector("#match-body-color-checkbox");
    assert.notEqual(matchCb, null);
    assert.strictEqual(
      matchCb.getAttribute("aria-describedby"),
      "match-body-color-label",
    );
    assert.include(host.textContent, "匹配身体颜色");

    assert.ok(
      [...host.querySelectorAll(".tree-label")].some((el) =>
        el.textContent.includes("Gear"),
      ),
    );
    assert.ok(
      [...host.querySelectorAll(".tree-node")].some((el) =>
        el.textContent.includes("Category Tree"),
      ),
    );
  });

  it("Expand Selected expands paths for the current selection", function () {
    seedBrowserCatalog(
      {
        ct_hat_1: {
          name: "Category Tree Hat",
          type_name: "hat",
          required: [...BODY_TYPES],
          animations: ["walk"],
          credits: [],
          layers: {},
          path: ["Gear"],
        },
      },
      {
        categoryTree: {
          items: [],
          children: {
            Gear: { items: ["ct_hat_1"], children: {} },
          },
        },
      },
    );
    state.selections.hat = {
      itemId: "ct_hat_1",
      name: "Category Tree Hat",
    };
    state.expandedNodes = {};

    m.render(host, m(CategoryTree, { catalog: defaultCatalog }));

    const expandBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "展开已选",
    );
    expandBtn.click();

    assert.isTrue(state.expandedNodes.Gear);
    assert.isTrue(state.expandedNodes.ct_hat_1);
  });

  it("Collapse All clears expanded nodes", function () {
    seedBrowserCatalog(
      {
        ct_hat_1: {
          name: "Category Tree Hat",
          type_name: "hat",
          required: [...BODY_TYPES],
          animations: ["walk"],
          credits: [],
          layers: {},
          path: ["Gear"],
        },
      },
      {
        categoryTree: {
          items: [],
          children: {
            Gear: { items: ["ct_hat_1"], children: {} },
          },
        },
      },
    );
    state.expandedNodes = { Gear: true };

    m.render(host, m(CategoryTree, { catalog: defaultCatalog }));

    const collapseBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === "全部折叠",
    );
    collapseBtn.click();

    assert.deepEqual(state.expandedNodes, {});
  });
});
