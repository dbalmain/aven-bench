/**
 * Client: EventSource for live updates, render run cards.
 * Dense, stable layout — numbers use tabular figures; no animated reflow.
 */

/** @typedef {import('../stats.ts').RunSummary} RunSummary */

const runsEl = document.getElementById("runs");
const emptyEl = document.getElementById("empty");
const updatedEl = document.getElementById("updated");
const themeBtn = document.getElementById("theme-btn");

function preferDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(mode) {
  if (mode === "dark") document.documentElement.setAttribute("data-theme", "dark");
  else if (mode === "light") document.documentElement.removeAttribute("data-theme");
  else {
    if (preferDark()) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }
}

const stored = localStorage.getItem("aven-bench-theme"); // "light" | "dark" | null (system)
applyTheme(stored);

themeBtn?.addEventListener("click", () => {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  localStorage.setItem("aven-bench-theme", next);
  applyTheme(next);
});

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtUsd(n) {
  if (n == null) return "—";
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function shortCommit(c) {
  if (!c) return "—";
  return c.length > 8 ? c.slice(0, 8) : c;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relTime(iso, now = Date.now()) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = Math.max(0, now - t);
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(t).toLocaleString();
}

function excludedNote(run) {
  if (!run.excluded) return "0 excluded";
  const parts = Object.entries(run.excludedByKind || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${n} ${k}`);
  return `${run.excluded} excluded${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function roundsHtml(hist) {
  const entries = Object.entries(hist || {})
    .map(([k, v]) => [Number(k), v])
    .filter(([k]) => Number.isFinite(k))
    .sort((a, b) => a[0] - b[0]);
  if (entries.length === 0) {
    return `<p class="rounds-empty">No passes yet — histogram empty.</p>`;
  }
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const rows = entries
    .map(([k, v]) => {
      const pct = ((v / max) * 100).toFixed(1);
      return `<div class="rounds-row">
        <span class="rk">${k} round${k === 1 ? "" : "s"}</span>
        <div class="rounds-bar" aria-hidden="true"><i style="--pct:${pct}%"></i></div>
        <span class="rv">${v}</span>
      </div>`;
    })
    .join("");
  const compact = entries.map(([k, v]) => `${k}: ${v}`).join(", ");
  return `<div class="rounds-hist" title="${esc(compact)}">${rows}</div>
    <p class="rounds-empty" style="margin-top:var(--space-3)">${esc(compact)}</p>`;
}

function failHtml(list) {
  if (!list || list.length === 0) {
    return `<p class="rounds-empty">None — all deduped tasks passed.</p>`;
  }
  const items = list
    .map((t) => {
      const kind = t.harnessErrorKind ? ` · ${t.harnessErrorKind}` : "";
      const codes = (t.diagnosticCodes || []).join(", ") || "—";
      return `<li class="fail-item">
        <span class="fail-task">${esc(t.taskId)}</span>
        <span class="fail-outcome">${esc(t.outcome)}${esc(kind)}</span>
        <span class="fail-codes" title="${esc(codes)}">${esc(codes)}</span>
      </li>`;
    })
    .join("");
  return `<ul class="fail-list">${items}</ul>`;
}

function progressLabel(run) {
  if (run.total != null) return `${run.done} of ${run.total}`;
  return `${run.done} done`;
}

function progressPct(run) {
  if (run.total != null && run.total > 0) {
    return Math.min(100, (run.done / run.total) * 100);
  }
  return null;
}

/**
 * @param {RunSummary} run
 */
function renderRun(run) {
  const pct = progressPct(run);
  const bar =
    pct != null
      ? `<div class="bar" role="progressbar" aria-valuenow="${run.done}" aria-valuemin="0" aria-valuemax="${run.total}"><i style="--pct:${pct.toFixed(1)}%"></i></div>`
      : `<div class="bar" aria-hidden="true"><i style="--pct:0%"></i></div>`;

  const models = (run.models || []).map(esc).join(", ") || "—";
  const langs = (run.languages || []).map(esc).join(", ") || "—";
  const sets = (run.taskSets || []).map(esc).join(", ") || "—";
  const docs = (run.docIds || []).map(esc).join(", ") || "—";
  const commits = (run.avenCommits || []).map(shortCommit).map(esc).join(", ") || "—";
  const desc = run.description && String(run.description).trim();
  const descHtml = desc ? `<p class="run-desc">${esc(desc)}</p>` : "";

  return `<article class="card run" data-status="${esc(run.status)}" data-run="${esc(run.runId)}">
    <div class="run-head">
      <div>
        <div class="run-id">${esc(run.runId)}</div>
        ${descHtml}
        <div class="run-meta">
          <span title="run start">${esc(fmtDate(run.startedAt))}</span>
          · <code>${models}</code>
          · ${langs}
          · ${sets}
          · doc <code>${docs}</code>
          · aven <code>${commits}</code>
        </div>
      </div>
      <span class="status status-${esc(run.status)}">${esc(run.status)}</span>
    </div>

    <div class="progress-block">
      <div class="progress-label">
        <span>${esc(progressLabel(run))}${run.rawRows !== run.done ? ` · ${run.rawRows} rows` : ""}</span>
        <span>elapsed ${esc(fmtDuration(run.elapsedMs))} · last activity ${esc(relTime(run.lastActivityAt))}</span>
      </div>
      ${bar}
    </div>

    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Pass rate</div>
        <div class="kpi-value">${esc(fmtPct(run.passRate))}</div>
        <div class="kpi-note">${run.passes}/${run.scored} scored · ${esc(excludedNote(run))}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">First-shot</div>
        <div class="kpi-value">${esc(fmtPct(run.firstShotRate))}</div>
        <div class="kpi-note">${run.firstShots}/${run.scored} scored</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Cost</div>
        <div class="kpi-value">${esc(fmtUsd(run.costUsd))}</div>
        <div class="kpi-note">sum of costUsd on deduped rows</div>
      </div>
    </div>

    <section class="rounds-panel">
      <h2 class="card-title">Rounds to green</h2>
      ${roundsHtml(run.roundsToGreen)}
    </section>

    <section>
      <h3 class="section-label">Non-passing (${(run.nonPassing || []).length})</h3>
      ${failHtml(run.nonPassing)}
    </section>
  </article>`;
}

/**
 * @param {{ runs: RunSummary[], at: string }} data
 */
function render(data) {
  const runs = data.runs || [];
  updatedEl.textContent = `updated ${relTime(data.at)} · ${runs.length} run${runs.length === 1 ? "" : "s"}`;
  if (runs.length === 0) {
    runsEl.innerHTML = "";
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  runsEl.innerHTML = runs.map(renderRun).join("");
}

async function fetchOnce() {
  const res = await fetch("/api/runs");
  if (!res.ok) throw new Error(String(res.status));
  render(await res.json());
}

function connect() {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    try {
      render(JSON.parse(ev.data));
    } catch (e) {
      console.error(e);
    }
  };
  es.onerror = () => {
    es.close();
    updatedEl.textContent = "reconnecting…";
    setTimeout(connect, 2_000);
  };
}

fetchOnce().catch(() => {});
connect();
// Keep relative times honest without waiting for the next SSE payload.
setInterval(() => {
  if (updatedEl.dataset.at) {
    /* no-op: full re-render comes from SSE every few seconds */
  }
}, 15_000);
