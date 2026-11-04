// Optional development/CI check: uses Playwright installed outside the application.
const http = require("node:http");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdirSync } = require("node:fs");
(async () => {
  const root = resolve(__dirname, "..");
  const names = process.argv.slice(2);
  if (
    !names.length ||
    names.some((n) => !/^tests\/browser-[a-z-]+\.cjs$/.test(n))
  )
    throw Error("Provide repository tests/browser-*.cjs scripts");
  process.env.ERP_MODE = "demo";
  process.env.VERCEL = "1";
  process.env.ERP_ALLOWED_HOSTS = "127.0.0.1";
  if (process.env.ERP_BROWSER_OUTPUT)
    mkdirSync(process.env.ERP_BROWSER_OUTPUT, { recursive: true });
  const entry = pathToFileURL(
    resolve(root, ".vercel/output/functions/erp.func/api/index.mjs"),
  ).href;
  const workers = await Promise.all(
    [0, 1, 2].map(
      async (i) => (await import(entry + "?browser-worker=" + i)).default,
    ),
  );
  let next = 0;
  const server = http.createServer((req, res) =>
    workers[next++ % workers.length](req, res),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const name of names) {
      const child = spawn(process.execPath, [resolve(root, name)], {
        cwd: root,
        env: {
          ...process.env,
          ERP_BROWSER_BASE_URL: "http://127.0.0.1:" + server.address().port,
        },
        stdio: "inherit",
        windowsHide: true,
      });
      const [code, signal] = await once(child, "exit");
      if (code !== 0) throw Error(name + " failed: " + (signal || code));
      console.log("PASS " + name + " across 3 rotating packaged demo workers");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
