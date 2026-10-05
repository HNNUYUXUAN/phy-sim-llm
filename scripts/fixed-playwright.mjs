import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const runtimeRoot = process.platform === "win32" ? "C:/ProgramData/PlaywrightRuntime" : "/opt/playwright-runtime";
export const browserStore = process.platform === "win32" ? "C:/ProgramData/ms-playwright" : "/opt/ms-playwright";
const runtimeEntry = join(runtimeRoot, "node_modules/playwright/index.mjs");
if (!existsSync(runtimeEntry)) throw new Error(`Fixed Playwright runtime missing: ${runtimeEntry}`);
if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH.replaceAll("\\", "/") !== browserStore) {
  throw new Error(`Unexpected browser store: ${process.env.PLAYWRIGHT_BROWSERS_PATH}; expected ${browserStore}`);
}
process.env.PLAYWRIGHT_BROWSERS_PATH = browserStore;
process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
const browserDefinitions = JSON.parse(readFileSync(join(runtimeRoot, "node_modules/playwright-core/browsers.json"), "utf8"));
const definition = browserDefinitions.browsers.find(item => item.name === "chromium-headless-shell");
if (!existsSync(join(browserStore, `chromium_headless_shell-${definition.revision}`))) throw new Error(`Fixed Chromium revision missing: ${definition.revision}`);
export const runtimeInfo = Object.freeze({
  runtimeRoot, browserStore,
  version: JSON.parse(readFileSync(join(runtimeRoot, "node_modules/playwright/package.json"), "utf8")).version,
  chromiumRevision: definition.revision,
  browserVersion: definition.browserVersion
});
const browserRuntime = await import(pathToFileURL(runtimeEntry).href);
const testingRuntime = await import(pathToFileURL(join(runtimeRoot, "node_modules/playwright/test.mjs")).href);
export const chromium = browserRuntime.chromium;
export const { test, expect, defineConfig } = testingRuntime;
