import { chromium, runtimeInfo } from "./fixed-playwright.mjs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import {blindPeak,settled} from './verify-reproduction.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const outputDir = resolve(option("--out") ?? join(root, "artifacts", `paper-figures-${Date.now()}`));
const appPath = resolve(option("--app") ?? join(root, "index.html"));
const appUrl = pathToFileURL(appPath);
const source = await readFile(appPath, "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
try { await readFile(join(outputDir,"manifest.json")); throw new Error("Capture output already contains evidence; choose a new output directory"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const defaults = { slitWidth: 1000, screenDistance: 50 };
const figures = [
  { file: "figure-03-overview.png", viewport: [945, 840], params: { wavelength: 550, slitSeparation: 5000, ...defaults, zoom: 1, compact: 0 }, description: "默认参数下的完整平台界面" },
  { file: "figure-04a-short-wavelength.png", viewport: [945, 520], params: { wavelength: 430, slitSeparation: 5000, ...defaults, zoom: 1, compact: 1 }, description: "短波长条件" },
  { file: "figure-04b-long-wavelength.png", viewport: [945, 520], params: { wavelength: 690, slitSeparation: 5000, ...defaults, zoom: 1, compact: 1 }, description: "长波长条件" },
  { file: "figure-05a-small-separation.png", viewport: [945, 520], params: { wavelength: 550, slitSeparation: 3400, ...defaults, zoom: 1, compact: 1 }, description: "小缝间距条件" },
  { file: "figure-05b-large-separation.png", viewport: [945, 520], params: { wavelength: 550, slitSeparation: 7600, ...defaults, zoom: 1, compact: 1 }, description: "大缝间距条件" },
  { file: "figure-06-high-order-zoom.png", viewport: [945, 520], params: { wavelength: 550, slitSeparation: 5000, ...defaults, zoom: 3, compact: 1 }, description: "高阶条纹显示缩放" },
  { file: "figure-07a-critical-bright.png", viewport: [945, 520], params: { wavelength: 660, slitSeparation: 6000, ...defaults, zoom: 1, compact: 1 }, description: "固定参考eta=0.11：一级亮纹条件" },
  { file: "figure-07b-critical-dark.png", viewport: [945, 520], params: { wavelength: 440, slitSeparation: 6000, ...defaults, zoom: 1, compact: 1 }, description: "同一参考eta=0.11：1.5级暗纹条件" },
  {
    file: "mobile-responsive.png",
    viewport: [390, 844],
    params: { wavelength: 550, slitSeparation: 5000, ...defaults, zoom: 1, compact: 0 },
    description: "移动端响应式布局验收",
    palette: "color",
    fullPage: true,
    publicationFigure: false
  }
];

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const manifest = [];
try {
  for (const figure of figures) {
    const context = await browser.newContext({
      viewport: { width: figure.viewport[0], height: figure.viewport[1] },
      deviceScaleFactor: 1,
      colorScheme: "light"
    });
    const page = await context.newPage();
    const errors = [], requests = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text().slice(0,500)); });
    page.on("pageerror", error => errors.push(error.message.slice(0,500)));
    await context.route("**/*", route => { if (/^https?:/i.test(route.request().url())) { requests.push(route.request().url().split("?")[0]); return route.abort(); } return route.continue(); });
    const url = new URL(appUrl);
    for (const [key, value] of Object.entries(figure.params)) url.searchParams.set(key, String(value));
    const palette = figure.palette ?? "grayscale";
    url.searchParams.set("palette", palette);
    url.searchParams.set("theme", "light");
    await page.goto(url.href);
    await page.evaluate(() => window.PhySim.ready);
    await settled(page);
    const actualParams=await page.evaluate(()=>window.PhySim.getParams());
    let observedPeak=null;
    if (figure.file.startsWith("figure-06") || figure.file.startsWith("figure-07")) {
      const canvas = page.locator("#intensityCanvas");
      const box = await canvas.boundingBox();
      if(figure.file.startsWith('figure-06'))observedPeak=await blindPeak(page,actualParams,2);
      const eta = observedPeak?.eta ?? .11;
      const x = box.width/2 + eta*4*figure.params.screenDistance*figure.params.zoom;
      if (x >= 0 && x <= box.width) await canvas.hover({position:{x,y:box.height/2}});
    }
    const path = join(outputDir, figure.file);
    await settled(page);
    await page.screenshot({ path, fullPage: figure.fullPage ?? true });
    const data = await readFile(path);
    manifest.push({
      file: figure.file,
      description: figure.description,
      viewport: { width: figure.viewport[0], height: figure.viewport[1] },
      params: actualParams,
      requestedParams:figure.params,
      observedPeak,
      idealSecondOrderEta:figure.file.startsWith('figure-06')?2*actualParams.wavelength/actualParams.slitSeparation:null,
      palette,
      theme: "light",
      dpr: 1,
      mode:'file:// with all external requests blocked',
      programSha256: sourceSha256,
      parameterProvenance: "本次冻结教学场景；不声称原论文未披露的参数已恢复",
      consoleErrors: errors,
      externalRequests: requests,
      publicationFigure: figure.publicationFigure ?? true,
      sha256: createHash("sha256").update(data).digest("hex")
    });
    await context.close();
  }
} finally {
  await browser.close();
}

await writeFile(
  join(outputDir, "manifest.json"),
  `${JSON.stringify({ appPath, sourceSha256, runtime: runtimeInfo, source: "maintenance-deployment-frozen-teaching-scenes", figures: manifest }, null, 2)}\n`,
  "utf8"
);
process.stdout.write(`Captured ${manifest.length} reproducibility screenshots in ${outputDir}\n`);
if(manifest.some(f=>f.consoleErrors.length||f.externalRequests.length))process.exitCode=1;
