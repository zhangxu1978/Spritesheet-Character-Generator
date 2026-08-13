// scripts/agent-pixinspect.js — sample pixel colors from the screenshot to
// verify the dark theme is being rendered.
import fs from "node:fs/promises";
import { PNG } from "pngjs";

const buf = await fs.readFile("tmp/agent-snap.png");
const png = PNG.sync.read(buf);
console.log("size:", png.width, "x", png.height);

function pix(x, y) {
  const idx = (png.width * y + x) << 2;
  return `rgb(${png.data[idx]},${png.data[idx + 1]},${png.data[idx + 2]})`;
}

console.log("top-left  bg:        ", pix(20, 20));
console.log("top-center title:     ", pix(700, 60));
console.log("mid-left chat panel:  ", pix(400, 400));
console.log("mid-right preview:    ", pix(1100, 400));
console.log("bottom-center:        ", pix(700, 850));
