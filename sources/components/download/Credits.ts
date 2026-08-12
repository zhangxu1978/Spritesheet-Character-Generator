// Credits/Attribution component
import m from "mithril";
import { state } from "../../state/state.ts";
import {
  getAllCredits,
  creditsToCsv,
  creditsToTxt,
} from "../../utils/credits.ts";
import { CollapsibleSection } from "../CollapsibleSection.ts";
import { downloadFile } from "../../canvas/download.ts";
import type { CatalogReader } from "../../state/catalog.ts";

export const Credits: m.Component<{ catalog: CatalogReader }> = {
  view(vnode) {
    const allCredits = getAllCredits(
      vnode.attrs.catalog,
      state.selections,
      state.bodyType,
    );

    return m(
      CollapsibleSection,
      {
        title: "署名与致谢",
        defaultOpen: true,
        boxClass: "box",
        id: "credits-section",
      },
      [
        m("p.is-size-7.mb-2", [
          "你必须为这些艺术作品标注原作者署名。",
          m(
            "a",
            {
              href: "https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator/blob/master/README.md",
              target: "_blank",
            },
            "详细署名说明",
          ),
        ]),
        m("p.is-size-7.mb-3", [
          "本生成器中所有精灵表的许可信息可查看",
          m(
            "a",
            {
              href: "https://github.com/liberatedpixelcup/Universal-LPC-Spritesheet-Character-Generator/raw/refs/heads/master/CREDITS.csv",
              target: "_blank",
            },
            "此处",
          ),
        ]),

        !state.previewBootstrapRenderDone
          ? m("p.has-text-grey", "正在加载选择…")
          : allCredits.length > 0
            ? [
                m(
                  "div.content.has-background-light.p-3",
                  allCredits.map((credit) =>
                    m("div.mb-3", { key: credit.file }, [
                      m("strong.is-size-6", credit.fileName),
                      credit.notes ? m("p.is-size-7", credit.notes) : null,
                      m("p.is-size-7", [
                        m("strong", "许可："),
                        credit.licenses.join(", "),
                      ]),
                      m("p.is-size-7", [
                        m("strong", "作者："),
                        credit.authors.join(", "),
                      ]),
                    ]),
                  ),
                ),
                m("div.buttons.mt-3", [
                  m(
                    "button.button.is-small",
                    {
                      onclick: () =>
                        downloadFile(creditsToTxt(allCredits), "credits.txt"),
                    },
                    "下载 TXT",
                  ),
                  m(
                    "button.button.is-small",
                    {
                      onclick: () =>
                        downloadFile(creditsToCsv(allCredits), "credits.csv"),
                    },
                    "下载 CSV",
                  ),
                ]),
              ]
            : m("p.has-text-grey", "尚未选择任何物品"),
      ],
    );
  },
};
