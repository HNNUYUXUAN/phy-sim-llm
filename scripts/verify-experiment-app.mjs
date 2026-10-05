import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium, runtimeInfo } from "./fixed-playwright.mjs";
import { hash, saveJson } from "./experiment-preflight.mjs";
import { defaults, matrix, oracle, numericalPeak, wavelengths, separations, referenceEta } from "./experiment-oracle.mjs";

const controlIds = ["wavelength", "slitSeparation", "slitWidth", "screenDistance", "zoom"];
export function inspectHtml(html, secrets = []) {
  const issues = [];
  if (!/<!doctype html>/i.test(html) || !/<\/html>/i.test(html)) issues.push("complete HTML document required");
  if (/<(?:script|link|img)[^>]*\b(?:src|href)\s*=\s*["']?(?!data:|#)[^\s>"']/i.test(html)) issues.push("external or separate-file resource reference");
  if (/\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest)|@import|url\(\s*["']?https?:/i.test(html)) issues.push("network-capable runtime dependency");
  const clean=html.replace(/<!--[\s\S]*?-->/g,'');
  const markup=clean.replace(/<(script|style|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
  const head=markup.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const meta=[...head.matchAll(/<meta\b[^>]*>/gi)].filter(m=>/http-equiv\s*=\s*(["'])Content-Security-Policy\1/i.test(m[0]));
  if(meta.length!==1) issues.push('exactly one real head offline CSP meta required');
  else {
    const policy=meta[0][0].match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] ?? '';
    const directives=new Map();
    for(const field of policy.split(';')){const [key,...values]=field.trim().split(/\s+/);if(!key)continue;if(directives.has(key))issues.push('duplicate CSP directive');directives.set(key,values);}
    const only=(key,tokens)=>{const values=directives.get(key)??directives.get('default-src')??[];return values.length>0&&values.every(v=>tokens.includes(v));};
    if(!only('default-src',["'none'"])||!only('connect-src',["'none'"])||!only('frame-src',["'none'"])||!only('object-src',["'none'"]))issues.push('CSP must deny default/connect/frame/object sources');
    if(!only('script-src',["'unsafe-inline'"])||!only('style-src',["'unsafe-inline'"])||!only('img-src',['data:',"'none'"]))issues.push('CSP must restrict scripts/styles to inline and images to data');
  }
  if(/<(?:iframe|object|embed|base)\b/i.test(clean)||/\b(?:src|href|xlink:href|poster)\s*=\s*(["'])(?:https?:|\/\/|file:)/i.test(clean))issues.push('external or embedded resource');
  if (secrets.some(secret => secret && html.includes(secret))) issues.push("credential found in candidate");
  return issues;
}

export async function verifyApp(appPath, output, { round = 7, secrets = [], full = round === 7 } = {}) {
  await mkdir(output, { recursive: true });
  const source = await readFile(appPath, "utf8");
  const report = { schemaVersion: 1, round, appSha256: hash(source), runtime: runtimeInfo, checks: [], numericalRows: [], observations: [], screenshots: [], untestedBrowsers: ["Firefox", "WebKit"] };
  const check = (name, passed, detail = null) => report.checks.push({ name, passed: Boolean(passed), detail });
  const staticIssues = inspectHtml(source, secrets);
  check("offline HTML and credential scan", staticIssues.length === 0, staticIssues);
  if (staticIssues.length) { report.passed = false; await saveJson(join(output, "verification.json"), report); return report; }
  const server = createServer((request, response) => {
    if (!["/", "/index.html"].includes(new URL(request.url, "http://localhost").pathname)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(source);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const dpr of full ? [1, 2, 3] : [1]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text().slice(0, 500)); });
      page.on("pageerror", error => errors.push(error.message.slice(0, 500)));
      await context.route("**/*", route => {
        const url = route.request().url();
        if (/^https?:/i.test(url) && !url.startsWith(baseUrl + "/")) { requests.push(url.split("?")[0]); return route.abort(); }
        return route.continue();
      });
      try {
        await page.goto(baseUrl + "/", { waitUntil: "load", timeout: 15000 });
        if (round >= 1) await page.waitForFunction(() => Boolean(window.PhySim?.ready), null, { timeout: 5000 });
        if (round >= 1) await page.evaluate(() => window.PhySim.ready);
        check(`DPR ${dpr}: title/content`, /双缝|干涉/.test(await page.title()) && (await page.locator("body").innerText()).length > 50);
        for (const id of [...controlIds, "interferenceCanvas", "intensityCanvas", "intensity-tooltip"]) check(`DPR ${dpr}: #${id}`, await page.locator(`#${id}`).count() === 1);
        const metrics = await page.evaluate(() => {
          const a = document.getElementById("interferenceCanvas"), b = document.getElementById("intensityCanvas");
          const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
          return { widthA: x.width, widthB: y.width, leftA: x.left, leftB: y.left, dpr: devicePixelRatio, ratioA: a.width / x.width, ratioB: b.width / y.width };
        });
        check(`DPR ${dpr}: canvas alignment`, metrics.widthA > 100 && Math.abs(metrics.widthA - metrics.widthB) < 1 && Math.abs(metrics.leftA - metrics.leftB) < 1, metrics);
        if (round >= 7) check(`DPR ${dpr}: backing resolution`, Math.abs(metrics.ratioA - dpr) < 0.02 && Math.abs(metrics.ratioB - dpr) < 0.02);
        if (round >= 1 && dpr === 1) {
          const center = await page.evaluate(() => window.PhySim.intensityAtEta(0));
          check("normalized center", Math.abs(center - 1) <= 1e-10, center);
        }
        if (round >= 2 && dpr === 1) {
          const constraint = await page.evaluate(() => { window.PhySim.setParams({ slitWidth: 3000, slitSeparation: 1000 }); return window.PhySim.getParams(); });
          check("a <= d normalized through API", constraint.slitWidth <= constraint.slitSeparation && constraint.slitSeparation === 1000, constraint);
          await page.evaluate(() => { window.PhySim.setParams(window.PhySim.defaults); const slider = document.getElementById("wavelength"); slider.value = "620"; slider.dispatchEvent(new Event("input", { bubbles: true })); });
          check("range input updates model", (await page.evaluate(() => window.PhySim.getParams())).wavelength === 620);
          await page.goto(baseUrl + "/?wavelength=9999&slitSeparation=1000&slitWidth=oops&screenDistance=-4&zoom=8&theme=dark&palette=grayscale&compact=1");
          await page.evaluate(() => window.PhySim.ready);
          const query = await page.evaluate(() => window.PhySim.getParams());
          check("URL clamp and invalid defaults", JSON.stringify(query) === JSON.stringify({ wavelength: 750, slitSeparation: 1000, slitWidth: 1000, screenDistance: 1, zoom: 5 }), query);
          await page.goto(baseUrl + "/"); await page.evaluate(() => window.PhySim.ready);
        }
        if (round >= 3 && dpr === 1) {
          const canvas = page.locator("#intensityCanvas");
          await canvas.hover({ position: { x: 100, y: 60 } });
          check("curve hover percentage", await page.locator("#intensity-tooltip").isVisible() && /%/.test(await page.locator("#intensity-tooltip").innerText()));
          await page.mouse.move(1, 1);
          check("hover hides on leave", !await page.locator("#intensity-tooltip").isVisible());
          await canvas.focus(); await page.keyboard.press("Home");
          check("keyboard curve probe", await page.locator("#intensity-tooltip").isVisible());
        }
        if (round >= 4 && dpr === 1) {
          const etas = Array.from({ length: 2001 }, (_, i) => (i - 1000) / 500);
          for (const params of matrix()) {
            const actual = await page.evaluate(({ params, etas }) => { window.PhySim.setParams(params); return etas.map(eta => window.PhySim.intensityAtEta(eta)); }, { params, etas });
            let maxError = 0, symmetry = 0;
            for (let i = 0; i < etas.length; i++) { maxError = Math.max(maxError, Math.abs(actual[i] - oracle(etas[i], params))); symmetry = Math.max(symmetry, Math.abs(actual[i] - actual[actual.length - 1 - i])); }
            const zeros = await page.evaluate(p => [window.PhySim.intensityAtEta(p.wavelength / p.slitWidth), window.PhySim.intensityAtEta(p.wavelength / (2 * p.slitSeparation)), p.slitWidth === p.slitSeparation ? window.PhySim.intensityAtEta(p.wavelength / p.slitSeparation) : 0], params);
            const passed = actual.every(x => Number.isFinite(x) && x >= -1e-12 && x <= 1 + 1e-12) && maxError <= 1e-10 && symmetry <= 1e-10 && zeros.every(x => Math.abs(x) <= 1e-10);
            report.numericalRows.push({ params, sampleCount: etas.length, maxError, symmetry, zeros, passed });
          }
          check("independent dense physical matrix", report.numericalRows.every(row => row.passed), { rows: report.numericalRows.length, samplesPerRow: 2001 });
          for (const [scan, values, key] of [["wavelength", wavelengths, "wavelength"], ["separation", separations, "slitSeparation"]]) {
            for (const value of values) {
              const params = { ...defaults, [key]: value };
              const idealEta = params.wavelength / params.slitSeparation;
              const missingIdealOrder = Math.abs(oracle(idealEta, params)) < 1e-10;
              const expectedPeak = missingIdealOrder ? null : numericalPeak(params);
              const observed = expectedPeak ? await page.evaluate(({ params, center, span }) => { window.PhySim.setParams(params); let best = { eta: 0, intensity: -1 }; for (let i = 0; i <= 2000; i++) { const eta = center + (i - 1000) * span / 1000; const intensity = window.PhySim.intensityAtEta(eta); if (intensity > best.intensity) best = { eta, intensity }; } return best; }, { params, center: expectedPeak.eta, span: idealEta * 0.02 }) : null;
              report.observations.push({ scan, value, params, idealInterferenceEta: idealEta, predictedSpacingCssPx: 4 * params.screenDistance * params.zoom * idealEta, missingIdealOrder, fullFormulaPeak: expectedPeak, observedPeak: observed, peakShiftFromIdealEta: observed ? observed.eta - idealEta : null, measurementUnit: "eta; display positions are CSS pixels, not physical distance" });
              if (observed) check(`${scan} ${value}: actual peak against full formula`, Math.abs(observed.eta - expectedPeak.eta) <= idealEta * 0.00003 && Math.abs(observed.intensity - expectedPeak.intensity) <= 1e-8);
            }
          }
          await page.evaluate(p => window.PhySim.setParams(p), defaults);
          const highOrder = numericalPeak(defaults, 2);
          const highObserved = await page.evaluate(eta => window.PhySim.intensityAtEta(eta), highOrder.eta);
          check("second-order peak below center", highObserved > 0 && highObserved < 1 && Math.abs(highObserved - highOrder.intensity) <= 1e-10, highOrder);
          const spacing = defaults.wavelength / defaults.slitSeparation;
          const widths = { central: spacing, secondOrder: (2.5 - 1.5) * spacing };
          const darkValues = await page.evaluate(spacing => [-0.5, 0.5, 1.5, 2.5].map(order => window.PhySim.intensityAtEta(order * spacing)), spacing);
          check("equal widths between adjacent interference dark fringes", widths.central === widths.secondOrder && darkValues.every(x => Math.abs(x) < 1e-10), widths);
          const scaleValues = [];
          for (const [screenDistance, zoom] of [[1, 1], [50, 3], [100, 5]]) scaleValues.push(await page.evaluate(({ screenDistance, zoom }) => { window.PhySim.setParams({ screenDistance, zoom }); return window.PhySim.intensityAtEta(0.071); }, { screenDistance, zoom }));
          check("display scale does not alter physics", scaleValues.every(x => Math.abs(x - scaleValues[0]) <= 1e-10), scaleValues);
          if (round >= 5) {
          await page.evaluate(p => window.PhySim.setParams(p), { ...defaults, slitSeparation: 6000, wavelength: 660 });
          const bright = await page.evaluate(eta => window.PhySim.intensityAtEta(eta), referenceEta);
          const markers = await page.evaluate(() => window.PhySim.getCriticalMarkers());
          await page.evaluate(() => window.PhySim.setParams({ wavelength: 440 }));
          const dark = await page.evaluate(eta => window.PhySim.intensityAtEta(eta), referenceEta);
          check("fixed reference bright-to-dark transition", bright > 0.8 && Math.abs(dark) <= 1e-10 && markers.wavelength.some(item => item.kind === "dark" && Math.abs(item.value - 440) < 1e-8), { bright, dark, markers });
          check("critical wavelength range", markers.wavelength.every(item => item.value >= 380 && item.value <= 750));
          }
        }
        if (round >= 6 && dpr === 1) {
          await page.locator("#principle-button").click();
          await page.getByRole("dialog").waitFor({ state: "visible", timeout: 3000 });
          check("principle diagram dialog opens", await page.getByRole("dialog").isVisible() && await page.getByRole("dialog").locator("svg").count() > 0);
          await page.keyboard.press("Escape");
          check("Escape returns focus", !await page.getByRole("dialog").isVisible() && await page.evaluate(() => document.activeElement?.id === "principle-button"));
        }
        if (round >= 7 && dpr === 1) {
          await page.locator("#theme-button").click(); const theme = await page.locator("html").getAttribute("data-theme");
          await page.locator("#palette-button").click(); const palette = await page.locator("html").getAttribute("data-palette");
          check("theme and grayscale controls", ["light", "dark"].includes(theme) && palette === "grayscale", { theme, palette });
          const viewport = { width: 390, height: 844 }; await page.setViewportSize(viewport); await page.reload(); await page.evaluate(() => window.PhySim.ready);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          check("mobile no horizontal overflow", overflow <= 0, overflow);
          const mobileFile = `mobile-dpr${dpr}.png`; await page.screenshot({ path: join(output, mobileFile), fullPage: true }); report.screenshots.push({ file: mobileFile, viewport, dpr, mode: "http" });
          await context.setOffline(true);
          await page.goto(pathToFileURL(resolve(appPath)).href); await page.evaluate(() => window.PhySim.ready);
          check("file:// works with network disabled", /双缝|干涉/.test(await page.title()));
          await page.evaluate(() => window.PhySim.setParams({ wavelength: 690 }));
          check("offline interaction", (await page.evaluate(() => window.PhySim.getParams())).wavelength === 690);
        }
        check(`DPR ${dpr}: zero external requests`, requests.length === 0, requests);
        check(`DPR ${dpr}: console and page health`, errors.length === 0, errors);
        await page.setViewportSize({ width: 1440, height: 900 });
        if (round >= 1) await page.evaluate(() => window.PhySim.setParams(window.PhySim.defaults));
        const screenshotFile = `desktop-dpr${dpr}.png`; await page.screenshot({ path: join(output, screenshotFile) }); report.screenshots.push({ file: screenshotFile, viewport: { width: 1440, height: 900 }, dpr, mode: "rendered" });
      } catch (error) { check(`DPR ${dpr}: execution completed`, false, error.message.slice(0, 500)); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
  report.passed = report.checks.every(item => item.passed);
  for (const item of report.screenshots) item.sha256 = hash(await readFile(join(output, item.file)));
  await saveJson(join(output, "verification.json"), report);
  if (report.observations.length) {
    const csv = ["scan,value,ideal_eta,observed_peak_eta,peak_shift_eta,peak_intensity,missing_ideal_order", ...report.observations.map(row => [row.scan, row.value, row.idealInterferenceEta, row.observedPeak?.eta ?? "", row.peakShiftFromIdealEta ?? "", row.observedPeak?.intensity ?? "", row.missingIdealOrder].join(","))].join("\n");
    await writeFile(join(output, "teaching-observations.csv"), csv + "\n");
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await verifyApp(resolve(process.argv[2] ?? "index.html"), resolve(process.argv[3] ?? "artifacts/baseline-verification"));
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks.length, failures: result.checks.filter(x => !x.passed) }));
  if (!result.passed) process.exitCode = 1;
}
