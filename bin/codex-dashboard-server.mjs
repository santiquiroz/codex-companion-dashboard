#!/usr/bin/env node
import { exec } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createJobActions } from "../lib/job-actions.mjs";
import { HttpError, samePath } from "../lib/job-target.mjs";
import { assertLoopbackRequest } from "../lib/loopback-guard.mjs";
import { pageContentSecurityPolicy } from "../lib/page-policy.mjs";
import { resolveStateDirs } from "../lib/state-dirs.mjs";
import { StateLockBusyError } from "../lib/state-store.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const MAX_PORT = 65535;
const MAX_BODY_BYTES = 1024 * 1024;
const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function parsePort(argv) {
  const portIndex = argv.indexOf("--port");
  if (portIndex === -1) {
    return DEFAULT_PORT;
  }

  const value = argv[portIndex + 1] ?? "";
  const port = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(port) || port > MAX_PORT) {
    throw new Error(`--port must be an integer between 0 and ${MAX_PORT}.`);
  }
  return port;
}

export function parseServerArgs(argv) {
  return { port: parsePort(argv), openBrowser: !argv.includes("--no-open") };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let settled = false;

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      if (settled) {
        return;
      }
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, "Request body is too large."));
      }
    });
    request.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (body.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON."));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  const content = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    ...BASE_HEADERS,
  });
  response.end(content);
}

function sendHtml(response) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(HTML_PAGE),
    "Content-Security-Policy": PAGE_SECURITY_POLICY,
    ...BASE_HEADERS,
  });
  response.end(HTML_PAGE);
}

const HTML_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Companion Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --background: #0d1117;
      --panel: #161b22;
      --panel-soft: #1c232d;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --amber: #d29922;
      --orange: #f0883e;
      --green: #3fb950;
      --red: #f85149;
      --gray: #8b949e;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-width: 320px;
      background: var(--background);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }

    main {
      width: min(1500px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0 48px;
    }

    header {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 24px;
    }

    h1 {
      margin: 0 0 6px;
      font-size: clamp(1.55rem, 3vw, 2.15rem);
      letter-spacing: -0.025em;
    }

    #summary {
      margin: 0;
      color: var(--muted);
      font-size: 0.95rem;
    }

    .connection {
      min-height: 20px;
      color: var(--muted);
      font-size: 0.85rem;
      text-align: right;
    }

    .connection.error {
      color: var(--red);
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
    }

    .filter {
      flex: 1 1 260px;
    }

    input[type="text"] {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--border);
      border-radius: 7px;
      outline: none;
      background: var(--background);
      color: var(--text);
      padding: 8px 11px;
      font: inherit;
    }

    input[type="text"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgb(88 166 255 / 15%);
    }

    .toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
    }

    button {
      min-height: 34px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel-soft);
      color: var(--text);
      padding: 6px 11px;
      font: inherit;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
    }

    button:hover:not(:disabled) {
      border-color: #6e7681;
      background: #262e39;
    }

    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    .danger {
      border-color: rgb(248 81 73 / 55%);
      color: #ffb4ae;
    }

    .table-shell {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel);
    }

    table {
      width: 100%;
      min-width: 1120px;
      border-collapse: collapse;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 0.84rem;
    }

    th,
    td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: middle;
      white-space: nowrap;
    }

    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 0.72rem;
      letter-spacing: 0.065em;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    tbody tr:hover {
      background: rgb(255 255 255 / 2%);
    }

    .title-cell {
      max-width: 36rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .badge {
      display: inline-block;
      min-width: 76px;
      border: 1px solid currentColor;
      border-radius: 999px;
      padding: 2px 8px;
      text-align: center;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }

    .badge.running,
    .badge.queued {
      color: var(--amber);
    }

    .badge.stale {
      color: var(--orange);
    }

    .badge.completed {
      color: var(--green);
    }

    .badge.failed {
      color: var(--red);
    }

    .badge.cancelled,
    .badge.unknown {
      color: var(--gray);
    }

    .empty {
      padding: 34px;
      color: var(--muted);
      text-align: center;
    }

    @media (max-width: 700px) {
      main {
        width: min(100% - 20px, 1500px);
        padding-top: 20px;
      }

      header {
        display: block;
      }

      .connection {
        margin-top: 8px;
        text-align: left;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Companion Dashboard</h1>
        <p id="summary">Loading jobs…</p>
      </div>
      <div id="connection" class="connection" role="status" aria-live="polite"></div>
    </header>

    <section class="toolbar" aria-label="Dashboard controls">
      <div class="filter">
        <input id="repo-filter" type="text" placeholder="Filter by repo name…" aria-label="Filter jobs by repo name">
      </div>
      <label class="toggle">
        <input id="auto-refresh" type="checkbox" checked>
        Auto-refresh
      </label>
      <button id="purge-stale" class="danger" type="button">Purge all stale</button>
    </section>

    <div class="table-shell">
      <table>
        <thead>
          <tr>
            <th>REPO</th>
            <th>STATUS</th>
            <th>JOB ID</th>
            <th>KIND</th>
            <th>STARTED</th>
            <th>ELAPSED/DURATION</th>
            <th>TITLE</th>
            <th>ACTIONS</th>
          </tr>
        </thead>
        <tbody id="jobs-body">
          <tr><td class="empty" colspan="8">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </main>

  <script>
    (function () {
      "use strict";

      var dashboard = {
        jobs: [],
        visibleJobs: [],
        timer: null,
        loading: false,
        busy: false
      };

      var summaryElement = document.getElementById("summary");
      var connectionElement = document.getElementById("connection");
      var filterElement = document.getElementById("repo-filter");
      var autoRefreshElement = document.getElementById("auto-refresh");
      var purgeElement = document.getElementById("purge-stale");
      var jobsBodyElement = document.getElementById("jobs-body");

      function isActive(job) {
        return job.status === "running" || job.status === "queued";
      }

      function parseTimestamp(value) {
        if (typeof value !== "string") {
          return null;
        }
        var timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? timestamp : null;
      }

      function jobStartTimestamp(job) {
        return parseTimestamp(job.startedAt || job.createdAt);
      }

      function sortTimestamp(value) {
        var timestamp = parseTimestamp(value);
        return timestamp === null ? Number.NEGATIVE_INFINITY : timestamp;
      }

      function sortJobs(jobs) {
        return jobs.slice().sort(function (left, right) {
          var leftActive = isActive(left);
          var rightActive = isActive(right);
          if (leftActive !== rightActive) {
            return leftActive ? -1 : 1;
          }
          if (leftActive) {
            return jobStartTimestamp(right) - jobStartTimestamp(left);
          }
          return sortTimestamp(right.updatedAt) - sortTimestamp(left.updatedAt);
        });
      }

      function pad(value) {
        return String(value).padStart(2, "0");
      }

      function formatStarted(job) {
        var timestamp = jobStartTimestamp(job);
        if (timestamp === null) {
          return "-";
        }
        var date = new Date(timestamp);
        return (
          date.getFullYear() +
          "-" +
          pad(date.getMonth() + 1) +
          "-" +
          pad(date.getDate()) +
          " " +
          pad(date.getHours()) +
          ":" +
          pad(date.getMinutes())
        );
      }

      function formatSpan(milliseconds) {
        if (!Number.isFinite(milliseconds)) {
          return "-";
        }
        var totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
        var hours = Math.floor(totalSeconds / 3600);
        var minutes = Math.floor((totalSeconds % 3600) / 60);
        var seconds = totalSeconds % 60;
        return hours >= 1
          ? hours + "h " + minutes + "m"
          : minutes + "m " + seconds + "s";
      }

      function formatElapsedOrDuration(job) {
        var start = jobStartTimestamp(job);
        if (start === null) {
          return "-";
        }
        if (isActive(job)) {
          return formatSpan(Date.now() - start);
        }
        var end = parseTimestamp(job.completedAt || job.updatedAt);
        return end === null ? "-" : formatSpan(end - start);
      }

      function truncateTitle(value) {
        var characters = Array.from(typeof value === "string" ? value : "");
        return characters.length > 60
          ? characters.slice(0, 59).join("") + "…"
          : characters.join("");
      }

      function escapeHtml(value) {
        return String(value === null || value === undefined ? "" : value).replace(
          /[&<>"']/g,
          function (character) {
            return {
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;"
            }[character];
          }
        );
      }

      function statusInfo(job) {
        if (job.stale) {
          return { label: "STALE", className: "stale" };
        }
        var status = typeof job.status === "string" ? job.status : "unknown";
        var known = ["running", "queued", "completed", "failed", "cancelled"];
        return {
          label: status.toUpperCase(),
          className: known.indexOf(status) === -1 ? "unknown" : status
        };
      }

      function updateSummary() {
        var staleCount = dashboard.jobs.filter(function (job) {
          return job.stale === true;
        }).length;
        var runningCount = dashboard.jobs.filter(function (job) {
          return isActive(job) && job.stale !== true;
        }).length;
        var finishedCount = dashboard.jobs.filter(function (job) {
          return !isActive(job);
        }).length;
        var repoCount = new Set(
          dashboard.jobs.map(function (job) {
            return job.repo;
          })
        ).size;

        summaryElement.textContent =
          runningCount +
          " running · " +
          staleCount +
          " stale · " +
          finishedCount +
          " finished · across " +
          repoCount +
          " repos";
        purgeElement.disabled = staleCount === 0 || dashboard.busy;
      }

      function render() {
        updateSummary();
        var query = filterElement.value.trim().toLocaleLowerCase();
        dashboard.visibleJobs = sortJobs(
          dashboard.jobs.filter(function (job) {
            return String(job.repo || "").toLocaleLowerCase().includes(query);
          })
        );

        if (dashboard.visibleJobs.length === 0) {
          jobsBodyElement.innerHTML =
            '<tr><td class="empty" colspan="8">' +
            (dashboard.jobs.length === 0
              ? "No Codex Companion jobs found."
              : "No repos match this filter.") +
            "</td></tr>";
          return;
        }

        jobsBodyElement.innerHTML = dashboard.visibleJobs
          .map(function (job, index) {
            var active = isActive(job);
            var status = statusInfo(job);
            var kind = job.kindLabel || job.kind || job.jobClass || "-";
            var fullTitle = typeof job.title === "string" ? job.title : "";
            var action = active ? "Cancel" : "Delete";
            var actionClass = active ? "danger" : "";
            return (
              "<tr>" +
              "<td>" +
              escapeHtml(job.repo || "-") +
              "</td>" +
              '<td><span class="badge ' +
              escapeHtml(status.className) +
              '">' +
              escapeHtml(status.label) +
              "</span></td>" +
              "<td>" +
              escapeHtml(job.id || "-") +
              "</td>" +
              "<td>" +
              escapeHtml(kind) +
              "</td>" +
              "<td>" +
              escapeHtml(formatStarted(job)) +
              "</td>" +
              "<td>" +
              escapeHtml(formatElapsedOrDuration(job)) +
              "</td>" +
              '<td class="title-cell" title="' +
              escapeHtml(fullTitle) +
              '">' +
              escapeHtml(truncateTitle(fullTitle) || "-") +
              "</td>" +
              "<td>" +
              '<button type="button" class="' +
              actionClass +
              '" data-action="' +
              action.toLocaleLowerCase() +
              '" data-index="' +
              index +
              '"' +
              (dashboard.busy ? " disabled" : "") +
              ">" +
              action +
              "</button>" +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
      }

      function setConnection(message, isError) {
        connectionElement.textContent = message;
        connectionElement.classList.toggle("error", Boolean(isError));
      }

      async function requestJson(url, options) {
        var response = await fetch(url, options);
        var payload;
        try {
          payload = await response.json();
        } catch {
          payload = {};
        }
        if (!response.ok) {
          throw new Error(payload.error || "Request failed with HTTP " + response.status + ".");
        }
        return payload;
      }

      async function refreshJobs() {
        if (dashboard.loading || dashboard.busy) {
          return;
        }
        dashboard.loading = true;
        try {
          var payload = await requestJson("/api/jobs");
          dashboard.jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
          render();
          setConnection("Updated " + new Date().toLocaleTimeString(), false);
        } catch (error) {
          setConnection(error.message || String(error), true);
        } finally {
          dashboard.loading = false;
        }
      }

      async function runMutation(url, body, successMessage) {
        dashboard.busy = true;
        render();
        setConnection("Working…", false);
        try {
          var payload = await requestJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          var message = typeof successMessage === "function" ? successMessage(payload) : successMessage;
          setConnection(message, false);
        } catch (error) {
          setConnection(error.message || String(error), true);
        } finally {
          dashboard.busy = false;
          await refreshJobs();
          render();
        }
      }

      function syncAutoRefresh() {
        if (dashboard.timer !== null) {
          window.clearInterval(dashboard.timer);
          dashboard.timer = null;
        }
        if (autoRefreshElement.checked) {
          dashboard.timer = window.setInterval(refreshJobs, 3000);
        }
      }

      filterElement.addEventListener("input", render);
      autoRefreshElement.addEventListener("change", syncAutoRefresh);

      function purgeResultMessage(payload) {
        var purgedCount = (payload.purged || []).length;
        var skippedCount = (payload.skipped || []).length;
        var message = "Purged " + purgedCount + " stale job(s).";
        if (skippedCount > 0) {
          message += " Skipped " + skippedCount + " repo(s) whose state file was locked; retry later.";
        }
        return message;
      }

      purgeElement.addEventListener("click", function () {
        var staleCount = dashboard.jobs.filter(function (job) {
          return job.stale === true;
        }).length;
        if (staleCount === 0) {
          return;
        }
        if (window.confirm("Cancel " + staleCount + " stale job(s)?")) {
          runMutation("/api/jobs/purge-stale", undefined, purgeResultMessage);
        }
      });

      jobsBodyElement.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }
        var job = dashboard.visibleJobs[Number(button.dataset.index)];
        if (!job) {
          return;
        }
        var target = {
          baseDir: job.baseDir,
          dirName: job.dirName,
          jobId: job.id
        };
        if (
          button.dataset.action === "cancel" &&
          window.confirm("Cancel job " + job.id + "?")
        ) {
          runMutation("/api/jobs/cancel", target, "Cancelled " + job.id + ".");
        } else if (
          button.dataset.action === "delete" &&
          window.confirm("Delete job " + job.id + "?")
        ) {
          runMutation("/api/jobs/delete", target, "Deleted " + job.id + ".");
        }
      });

      syncAutoRefresh();
      refreshJobs();
    })();
  </script>
</body>
</html>
`;

const PAGE_SECURITY_POLICY = pageContentSecurityPolicy(HTML_PAGE);

async function handleRequest(actions, request, response) {
  assertLoopbackRequest({ method: request.method, headers: request.headers, port: request.socket.localPort });
  const requestUrl = new URL(request.url || "/", `http://${HOST}`);
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/") {
    sendHtml(response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/jobs") {
    const jobs = await actions.listJobs();
    sendJson(response, 200, { jobs });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/cancel") {
    const body = await readJsonBody(request);
    const cancellation = await actions.cancelJob(body);
    sendJson(response, 200, { ok: true, ...cancellation });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/purge-stale") {
    const { purged, skipped } = await actions.purgeStaleJobs();
    sendJson(response, 200, { ok: true, purged, skipped });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/delete") {
    const body = await readJsonBody(request);
    const deleted = await actions.deleteJob(body);
    sendJson(response, 200, { ok: true, deleted });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API route not found." });
    return;
  }

  const content = "Not found\n";
  response.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    ...BASE_HEADERS,
  });
  response.end(content);
}

function errorStatusCode(error) {
  if (error instanceof StateLockBusyError) {
    return 409;
  }
  if (error instanceof HttpError && Number.isInteger(error.statusCode)) {
    return error.statusCode;
  }
  return 500;
}

function respondWithError(response, error) {
  const statusCode = errorStatusCode(error);
  const message = error instanceof Error ? error.message : String(error);

  if (!response.headersSent) {
    sendJson(response, statusCode, { error: message });
  } else if (!response.writableEnded) {
    response.end();
  }
}

function serverUrl(server) {
  return `http://${HOST}:${server.address().port}`;
}

function launchBrowserOnWindows(url) {
  if (process.platform !== "win32") {
    return;
  }
  try {
    exec(`start "" "${url}"`, { windowsHide: true }, () => {});
  } catch {
    // Auto-opening the browser is a convenience and must never crash the server.
  }
}

export function createServer({
  baseDirs = resolveStateDirs(),
  openBrowser = false,
  launchBrowser = launchBrowserOnWindows,
} = {}) {
  const actions = createJobActions({ baseDirs });
  const server = http.createServer((request, response) => {
    handleRequest(actions, request, response).catch((error) => respondWithError(response, error));
  });

  if (openBrowser) {
    server.once("listening", () => launchBrowser(serverUrl(server)));
  }
  return server;
}

function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return samePath(fs.realpathSync(process.argv[1]), fs.realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

function main(argv) {
  const { port, openBrowser } = parseServerArgs(argv);
  const server = createServer({ openBrowser });
  server.listen(port, HOST, () => {
    console.log(`Codex Dashboard running at ${serverUrl(server)}`);
  });
}

if (isMainModule()) {
  main(process.argv.slice(2));
}
