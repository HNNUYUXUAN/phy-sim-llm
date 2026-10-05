import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, runtimeInfo } from "./fixed-playwright.mjs";

export const hash = value => createHash("sha256").update(value).digest("hex");
export async function saveJson(path, value) { const tmp=path+'.tmp-'+process.pid+'-'+randomUUID();await writeFile(tmp,JSON.stringify(value,null,2)+'\n','utf8');await rename(tmp,path); }
export const positions = [
  { controls: "left", pattern: "right-top", curve: "right-bottom" },
  { controls: "right", pattern: "left-bottom", curve: "left-top" }
];
export async function makeWireframes(output) {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const paths = [];
  try {
    for (let i = 0; i < 2; i++) {
      const reversed = i === 1;
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>实验线框 ${i + 1}</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;font:22px Arial,sans-serif;color:#111;padding:32px}h1{font-size:26px}main{display:grid;grid-template-columns:${reversed ? "2fr 1fr" : "1fr 2fr"};grid-template-rows:240px 240px;gap:20px}.box{border:3px solid #111;padding:24px;background:#f5f5f5}.controls{grid-column:${reversed ? "2" : "1"};grid-row:1/3}.pattern{grid-column:${reversed ? "1" : "2"};grid-row:${reversed ? "2" : "1"}}.curve{grid-column:${reversed ? "1" : "2"};grid-row:${reversed ? "1" : "2"}}label{display:block;margin-top:20px;font-size:17px}input{width:100%}.stripe{height:120px;margin-top:20px;background:repeating-linear-gradient(90deg,#111 0px,#111 8px,#fff 16px,#fff 20px)}svg{width:100%;height:140px;margin-top:16px}</style><h1>杨氏双缝教学界面 - 独立需求线框</h1><main><section class="box controls">CONTROLS 参数调控${["wavelength 波长","slitSeparation 缝间距","slitWidth 缝宽","screenDistance 显示屏距","zoom 缩放"].map(x=>`<label>${x}<input type="range"></label>`).join("")}</section><section class="box pattern">PATTERN 干涉条纹图样<div class="stripe"></div></section><section class="box curve">CURVE 归一化光强<svg viewBox="0 0 500 120"><path d="M0 110 L500 110 M250 0 L250 115" fill="none" stroke="#999"/><path d="M20 108 Q80 85 130 102 Q180 105 210 70 Q250 -55 290 70 Q320 105 370 102 Q420 85 480 108" fill="none" stroke="#111" stroke-width="3"/></svg></section></main></html>`;
      const htmlPath = join(output, `wireframe-${i + 1}.html`);
      const pngPath = join(output, `wireframe-${i + 1}.png`);
      await writeFile(htmlPath, html);
      const page = await browser.newPage({ viewport: { width: 1100, height: 650 }, deviceScaleFactor: 1 });
      await page.goto(pathToFileURL(htmlPath).href);
      await page.screenshot({ path: pngPath });
      await page.close();
      paths.push(pngPath);
    }
  } finally { await browser.close(); }
  return paths;
}
