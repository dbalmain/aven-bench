/**
 * Live web dashboard for benchmark runs.
 *
 * Read-only over data/runs/: tails JSONL files, never writes. Start with
 * `bun run dashboard`. Safe to leave open while a multi-hour sweep appends.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { REPO_ROOT, CORPUS_DIR, DATA_DIR } from "../ingest/paths.ts";
import { createWatchState, loadSplitSizesSync, pollWatch, summariesFromWatch } from "./watch.ts";
import type { RunSummary } from "./stats.ts";

const RUNS_DIR = join(DATA_DIR, "runs");
const SPLIT_PATH = join(CORPUS_DIR, "split.json");
const POLL_MS = 3_000;
const DEFAULT_PORT = 8787;

/** House style tokens/components; override with AVEN_BENCH_STYLE_DIR. */
function styleDir(): string {
  const env = process.env["AVEN_BENCH_STYLE_DIR"];
  if (env) return resolve(env);
  return resolve(homedir(), "w/ai-tools/style/web");
}

function parsePort(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
    const m = argv[i]?.match(/^--port=(\d+)$/);
    if (m) return Number(m[1]);
  }
  const env = process.env["PORT"];
  if (env && Number.isFinite(Number(env))) return Number(env);
  return DEFAULT_PORT;
}

const splitText = readFileSync(SPLIT_PATH, "utf8");
const split = loadSplitSizesSync(splitText);
const watch = createWatchState(RUNS_DIR, split);

// Prime state before serving so the first paint has data.
await pollWatch(watch);

let snapshot: RunSummary[] = summariesFromWatch(watch);
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

function pushSnapshot(): void {
  snapshot = summariesFromWatch(watch);
  const payload = enc.encode(`data: ${JSON.stringify({ runs: snapshot, at: new Date().toISOString() })}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(payload);
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(async () => {
  try {
    await pollWatch(watch);
    pushSnapshot();
  } catch (e) {
    console.error("poll error:", e);
  }
}, POLL_MS);

function pageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>aven-bench · runs</title>
<link rel="stylesheet" href="/style/tokens.css">
<link rel="stylesheet" href="/style/components.css">
<link rel="stylesheet" href="/app.css">
</head>
<body>
  <div class="wrap">
    <header class="site-header">
      <div>
        <a class="site-title" href="/">aven-bench</a>
        <p class="page-sub">Live run dashboard · read-only over <code>data/runs/</code></p>
      </div>
      <div class="header-meta">
        <span id="updated" class="kpi-label">connecting…</span>
        <button type="button" class="btn btn-ghost btn-sm" id="theme-btn" aria-label="Toggle theme">theme</button>
      </div>
    </header>
    <main id="runs" class="runs" aria-live="polite"></main>
    <p id="empty" class="empty hint" hidden>No run files under data/runs/.</p>
  </div>
  <script src="/app.js" type="module"></script>
</body>
</html>`;
}

function contentType(path: string): string {
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

const port = parsePort(process.argv.slice(2));
const styles = styleDir();

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(pageHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (pathname === "/api/runs") {
      return Response.json({ runs: snapshot, at: new Date().toISOString() });
    }

    if (pathname === "/api/events") {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          clients.add(c);
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ runs: snapshot, at: new Date().toISOString() })}\n\n`,
            ),
          );
        },
        cancel() {
          clients.delete(controller);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (pathname === "/style/tokens.css" || pathname === "/style/components.css") {
      const name = pathname === "/style/tokens.css" ? "tokens.css" : "components.css";
      const filePath = join(styles, name);
      if (!existsSync(filePath)) {
        return new Response(`missing style file: ${filePath}`, { status: 404 });
      }
      return new Response(Bun.file(filePath), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }

    if (pathname === "/app.css" || pathname === "/app.js") {
      const filePath = join(REPO_ROOT, "dashboard", "public", pathname.slice(1));
      return new Response(Bun.file(filePath), {
        headers: { "content-type": contentType(filePath) },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`aven-bench dashboard  http://localhost:${server.port}/`);
console.log(`watching ${RUNS_DIR}  (poll ${POLL_MS}ms, read-only)`);
console.log(`split tune=${split.tune} holdout=${split.holdout}  style=${styles}`);
