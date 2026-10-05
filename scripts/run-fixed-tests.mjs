import { spawn } from "node:child_process";
import { join } from "node:path";
import { runtimeInfo } from "./fixed-playwright.mjs";
const cli = join(runtimeInfo.runtimeRoot, "node_modules", "playwright", "cli.js");
const child = spawn(process.execPath, [cli, "test", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
