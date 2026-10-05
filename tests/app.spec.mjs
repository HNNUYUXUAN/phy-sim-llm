import { test, expect } from "../scripts/fixed-playwright.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
test('probe keeps physical eta after zoom and resize, and hides on leave', async ({page}) => {
  await page.goto('/');
  await page.evaluate(()=>window.PhySim.ready);
  const canvas=page.locator('#intensityCanvas');
  let box=await canvas.boundingBox();
  await canvas.hover({position:{x:box.width/2+22,y:box.height/2}});
  const before=await page.locator('#intensity-tooltip').innerText();
  await page.evaluate(()=>window.PhySim.setParams({zoom:3}));
  await page.waitForTimeout(100);
  await expect(page.locator('#intensity-tooltip')).toHaveText(before);
  await page.setViewportSize({width:1100,height:900});
  await page.waitForTimeout(100);
  await expect(page.locator('#intensity-tooltip')).toHaveText(before);
  await page.mouse.move(0,0);
  await expect(page.locator('#intensity-tooltip')).toBeHidden();
});
const offlineEntry = pathToFileURL(join(projectRoot, "index.html")).href;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.PhySim.ready);
});

test("loads the complete offline scientific interface without console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await expect(page).toHaveTitle("杨氏双缝干涉仿真");
  await expect(page.getByRole("heading", { name: "参数调控" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "干涉条纹图样" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "归一化光强" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("opens from file URL with no external requests or console errors", async ({ page }) => {
  const externalRequests = [];
  const errors = [];
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(offlineEntry);
  await page.evaluate(() => window.PhySim.ready);

  await expect(page).toHaveTitle("杨氏双缝干涉仿真");
  expect(externalRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test("implements the normalized interference-diffraction model", async ({ page }) => {
  const result = await page.evaluate(() => {
    const api = window.PhySim;
    const p = api.getParams();
    const samples = [];
    for (let eta = -2; eta <= 2; eta += 0.01) samples.push(api.intensityAtEta(eta));
    return {
      center: api.intensityAtEta(0),
      symmetry: Math.abs(api.intensityAtEta(0.071) - api.intensityAtEta(-0.071)),
      envelopeZero: api.intensityAtEta(p.wavelength / p.slitWidth),
      darkFringe: api.intensityAtEta(0.5 * p.wavelength / p.slitSeparation),
      min: Math.min(...samples),
      max: Math.max(...samples)
    };
  });
  expect(result.center).toBeCloseTo(1, 12);
  expect(result.symmetry).toBeLessThan(1e-12);
  expect(result.envelopeZero).toBeLessThan(1e-12);
  expect(result.darkFringe).toBeLessThan(1e-12);
  expect(result.min).toBeGreaterThanOrEqual(0);
  expect(result.max).toBeLessThanOrEqual(1);
});

test("critical markers satisfy the fixed-reference equations", async ({ page }) => {
  const markers = await page.evaluate(() => window.PhySim.getCriticalMarkers());
  const wavelengthBright = markers.wavelength.find((item) => item.kind === "bright" && item.order === 1);
  const slitBright = markers.slitSeparation.find((item) => item.kind === "bright" && item.order === 1);
  const slitDark = markers.slitSeparation.find((item) => item.kind === "dark" && item.order === 0.5);
  expect(wavelengthBright.value).toBeCloseTo(550, 8);
  expect(slitBright.value).toBeCloseTo(5000, 8);
  expect(slitDark.value).toBeCloseTo(2500, 8);
  await expect(page.locator("#wavelength-markers .bright")).toHaveCount(markers.wavelength.filter((item) => item.kind === "bright").length);
  await expect(page.locator("#slitSeparation-markers .dark")).toHaveCount(markers.slitSeparation.filter((item) => item.kind === "dark").length);
});

test("controls update state and enforce slitWidth <= slitSeparation", async ({ page }) => {
  await page.evaluate(() => window.PhySim.setParams({ slitWidth: 3000, slitSeparation: 5000 }));
  await page.locator("#slitSeparation").evaluate((element) => {
    element.value = "1000";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#slitWidth-output")).toHaveText("1000 nm");
  const params = await page.evaluate(() => window.PhySim.getParams());
  expect(params.slitWidth).toBe(1000);
  expect(params.slitSeparation).toBe(1000);
});

test("curve hover, modal, theme and palette controls are interactive", async ({ page }) => {
  const canvas = page.locator("#intensityCanvas");
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await canvas.hover({ position: { x: box.width * 0.62, y: box.height * 0.5 } });
  await expect(page.locator("#intensity-tooltip")).toBeVisible();
  await expect(page.locator("#intensity-tooltip")).toContainText("Iₙ");
  await expect(page.locator("#intensity-tooltip")).toContainText("%");

  await canvas.focus();
  await page.keyboard.press("Home");
  await expect(page.locator("#intensity-tooltip")).toBeVisible();
  await expect(page.locator("#intensity-tooltip")).toContainText("η");

  await page.locator("#principle-button").click();
  await expect(page.locator("#principle-modal")).toHaveAttribute("aria-hidden", "false");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#principle-modal")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#principle-button")).toBeFocused();

  await page.locator("#theme-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator("#palette-button").click();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "grayscale");
});

test("query parameters restore and clamp reproducible state", async ({ page }) => {
  await page.goto("/?wavelength=9999&slitSeparation=1000&slitWidth=oops&screenDistance=-4&zoom=8&theme=dark&palette=grayscale&compact=1");
  await page.evaluate(() => window.PhySim.ready);
  expect(await page.evaluate(() => window.PhySim.getParams())).toEqual({
    wavelength: 750,
    slitSeparation: 1000,
    slitWidth: 1000,
    screenDistance: 1,
    zoom: 5
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-palette", "grayscale");
  await expect(page.locator("body")).toHaveAttribute("data-compact", "true");
});

test("canvas backing stores follow DPR and remain horizontally aligned", async ({ page }) => {
  const metrics = await page.evaluate(() => {
    const pattern = document.getElementById("interferenceCanvas");
    const intensity = document.getElementById("intensityCanvas");
    return {
      dpr: window.devicePixelRatio,
      patternRatio: pattern.width / pattern.clientWidth,
      intensityRatio: intensity.width / intensity.clientWidth,
      patternLeft: pattern.getBoundingClientRect().left,
      intensityLeft: intensity.getBoundingClientRect().left,
      patternWidth: pattern.clientWidth,
      intensityWidth: intensity.clientWidth
    };
  });
  expect(metrics.patternRatio).toBeCloseTo(metrics.dpr, 1);
  expect(metrics.intensityRatio).toBeCloseTo(metrics.dpr, 1);
  expect(metrics.patternLeft).toBeCloseTo(metrics.intensityLeft, 5);
  expect(metrics.patternWidth).toBe(metrics.intensityWidth);
});

test("mobile layout has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.evaluate(() => window.PhySim.ready);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    patternWidth: document.getElementById("interferenceCanvas").clientWidth,
    intensityWidth: document.getElementById("intensityCanvas").clientWidth
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.patternWidth).toBe(layout.intensityWidth);
});
