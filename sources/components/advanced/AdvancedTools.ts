// Advanced Tools component - Custom file upload with z-position
import m from "mithril";
import { state } from "../../state/state.ts";
import { CollapsibleSection } from "../CollapsibleSection.ts";

export const AdvancedTools: m.Component = {
  view() {
    const handleFileUpload = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const img = new Image();
      img.onload = () => {
        state.customUploadedImage = img;
        m.redraw();
      };
      img.src = URL.createObjectURL(file);
    };

    const handleZPosChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const value = parseInt(target.value, 10);
      state.customImageZPos = isNaN(value) ? 0 : value;
      m.redraw();
    };

    const clearCustomImage = () => {
      state.customUploadedImage = null;
      state.customImageZPos = 0;
      const fileInput = document.getElementById(
        "customFileInput",
      ) as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      m.redraw();
    };

    return m(
      CollapsibleSection,
      {
        title: "高级工具",
        defaultOpen: false,
      },
      [
        m("div.field", [
          m("label.label", "自定义文件上传"),
          m("div.control", [
            m("input.input[type=file]#customFileInput", {
              accept: "image/*",
              onchange: handleFileUpload,
            }),
          ]),
          m(
            "p.help",
            "上传本地图片文件以叠加到精灵表上",
          ),
        ]),
        m("div.field", [
          m("label.label", "Z 轴位置"),
          m("div.control", [
            m("input.input[type=number]", {
              value: state.customImageZPos,
              oninput: handleZPosChange,
              placeholder: "0",
            }),
          ]),
          m("p.help", [
            "图层顺序：",
            m("code", "0=阴影"),
            "，",
            m("code", "10=身体"),
            "，",
            m("code", "70=手臂"),
            "，",
            m("code", "110=胡须"),
          ]),
        ]),
        state.customUploadedImage &&
          m("div.field", [
            m("div.control", [
              m(
                "button.button.is-small.is-warning",
                {
                  onclick: clearCustomImage,
                },
                "清除自定义图片",
              ),
            ]),
          ]),
      ],
    );
  },
};
