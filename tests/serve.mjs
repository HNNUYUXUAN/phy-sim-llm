import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appPath = process.argv[2] ? resolve(process.argv[2]) : join(root, "index.html");
const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);

const server = createServer(async (request, response) => {
  const path = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (path !== "/" && path !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const content = await readFile(appPath);
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(content);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(error));
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`phy-sim-llm listening on http://127.0.0.1:${server.address().port}\n`);
});
