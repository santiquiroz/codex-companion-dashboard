#!/usr/bin/env node
import { exec, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { companionEnvFor, findCompanionScript, runCompanionCancel } from "../lib/companion-cancel.mjs";
import { createLivenessProbe, killIfJobProcess } from "../lib/process-identity.mjs";
import { StateLockBusyError, withStateLock, writeStateAtomic } from "../lib/state-store.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const PLUGIN_DATA_STATE_DIR = path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex", "state");
const BASE_DIRS = [PLUGIN_DATA_STATE_DIR, path.join(os.tmpdir(), "codex-companion")];
const ACTIVE_STATUSES = new Set(["running", "queued"]);
const MAX_BODY_BYTES = 1024 * 1024;
const DASHBOARD_CANCEL_MESSAGE = "Cancelled via dashboard.";
const livenessProbe = createLivenessProbe();

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function parsePort(argv) {
  const portIndex = argv.indexOf("--port");
  if (portIndex === -1) {
    return DEFAULT_PORT;
  }

  const port = Number(argv[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return port;
}

function isJobRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function probeActiveJob(job) {
  return ACTIVE_STATUSES.has(job.status) ? livenessProbe.probe(job) : null;
}

function isStaleLiveness(job, alive) {
  return ACTIVE_STATUSES.has(job.status) && alive === false;
}

function readStateFile(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return isJobRecord(state) && Array.isArray(state.jobs) ? state : null;
  } catch {
    return null;
  }
}

function collectJobRecords() {
  const records = [];
  const seen = new Set();

  for (const baseDir of BASE_DIRS) {
    let entries;
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const dirName = entry.name;
      const statePath = path.join(baseDir, dirName, "state.json");
      // Missing, unreadable, and malformed state files are intentionally skipped.
      const state = readStateFile(statePath);
      if (!state) {
        continue;
      }

      const repo = dirName.replace(/-[0-9a-f]{16}$/, "");
      for (const sourceJob of state.jobs) {
        if (!isJobRecord(sourceJob)) {
          continue;
        }

        const dedupeKey = `${dirName}:${sourceJob.id}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        records.push({
          view: {
            ...sourceJob,
            repo,
            dirName,
            baseDir,
          },
          sourceJob,
          statePath,
          repo,
          dirName,
          baseDir,
        });
      }
    }
  }

  return records;
}

async function withLiveness(record) {
  const alive = await probeActiveJob(record.sourceJob);
  const stale = isStaleLiveness(record.sourceJob, alive);
  return { ...record, view: { ...record.view, alive, stale } };
}

async function scanAllJobRecords() {
  return Promise.all(collectJobRecords().map(withLiveness));
}

function bestEffortKill(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // The process may already be gone; cancellation still updates the job state.
  }
}

function bestEffortAppendCancellationLog(job, timestamp) {
  try {
    if (typeof job.logFile === "string" && fs.existsSync(job.logFile)) {
      fs.appendFileSync(
        job.logFile,
        `[${timestamp}] Cancelled via dashboard GUI.\n`,
        "utf8",
      );
    }
  } catch {
    // Logging must not make an otherwise successful cancellation fail.
  }
}

function cancelledJob(job, timestamp) {
  return {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: DASHBOARD_CANCEL_MESSAGE,
    completedAt: timestamp,
    cancelledAt: timestamp,
    updatedAt: timestamp,
  };
}

function jobFilePath(repoDir, jobId) {
  return path.join(repoDir, "jobs", `${jobId}.json`);
}

function readJobFile(filePath) {
  try {
    const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isJobRecord(job) ? job : null;
  } catch {
    return null;
  }
}

// Mirrors the plugin's cancel: /codex:status and /codex:result read jobs/<id>.json, not state.json.
async function bestEffortMergeIntoJobFile(repoDir, job) {
  const filePath = jobFilePath(repoDir, job.id);
  const existing = readJobFile(filePath);
  if (!existing) {
    return;
  }
  try {
    await writeStateAtomic(filePath, { ...existing, ...job });
  } catch {
    // state.json already records the cancellation; the sidecar must not fail the request.
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isSafePathSegment(value) {
  return (
    isNonEmptyString(value) &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value
  );
}

function requireJobTarget(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !isNonEmptyString(body.baseDir) ||
    !isNonEmptyString(body.dirName) ||
    !isNonEmptyString(body.jobId)
  ) {
    throw new HttpError(400, "baseDir, dirName, and jobId are required.");
  }

  const baseDir = BASE_DIRS.find((candidate) => samePath(candidate, body.baseDir));
  if (!baseDir) {
    throw new HttpError(400, "baseDir is not a recognized Codex Companion state directory.");
  }
  if (!isSafePathSegment(body.dirName)) {
    throw new HttpError(400, "dirName must be a direct state-directory name.");
  }
  if (!isSafePathSegment(body.jobId)) {
    throw new HttpError(400, "jobId must be a simple job identifier.");
  }

  const repoDir = path.resolve(baseDir, body.dirName);
  if (!samePath(path.dirname(repoDir), baseDir)) {
    throw new HttpError(400, "dirName must resolve directly beneath baseDir.");
  }

  return {
    baseDir,
    dirName: body.dirName,
    jobId: body.jobId,
    repoDir,
    statePath: path.join(repoDir, "state.json"),
  };
}

function readTargetState(target) {
  let text;
  try {
    text = fs.readFileSync(target.statePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new HttpError(404, "Job not found.");
    }
    throw error;
  }

  const state = JSON.parse(text);
  if (!state || typeof state !== "object" || !Array.isArray(state.jobs)) {
    throw new HttpError(404, "Job not found.");
  }
  return state;
}

function findJob(state, jobId) {
  return state.jobs.find((job) => job && typeof job === "object" && job.id === jobId);
}

async function mutateTargetState(target, mutate) {
  if (!fs.existsSync(target.statePath)) {
    throw new HttpError(404, "Job not found.");
  }

  return withStateLock(target.repoDir, async () => {
    const state = readTargetState(target);
    const result = mutate(state);
    await writeStateAtomic(target.statePath, state);
    return result;
  });
}

function requireActiveJob(state, jobId) {
  const job = findJob(state, jobId);
  if (!job) {
    throw new HttpError(404, "Job not found.");
  }
  if (!ACTIVE_STATUSES.has(job.status)) {
    throw new HttpError(400, "Only running or queued jobs can be cancelled.");
  }
  return job;
}

function cancelActiveJob(state, jobId) {
  const original = requireActiveJob(state, jobId);
  const cancelled = cancelledJob(original, new Date().toISOString());
  state.jobs = state.jobs.map((job) => (job === original ? cancelled : job));
  return { original, cancelled };
}

async function stopCancelledJob(original, cancelled) {
  await killIfJobProcess(original, { probe: livenessProbe, kill: bestEffortKill });
  bestEffortAppendCancellationLog(cancelled, cancelled.completedAt);
}

async function cancelInDashboard(target) {
  const { original, cancelled } = await mutateTargetState(target, (state) =>
    cancelActiveJob(state, target.jobId),
  );
  await bestEffortMergeIntoJobFile(target.repoDir, cancelled);
  await stopCancelledJob(original, cancelled);
  return cancelled;
}

function hasCancelArguments(job) {
  return (
    isNonEmptyString(job.workspaceRoot) &&
    path.isAbsolute(job.workspaceRoot) &&
    !job.id.startsWith("-")
  );
}

// Only a verified live worker goes to the plugin: its cancel kills job.pid without checking whose it is.
async function shouldDelegateCancel(job) {
  return hasCancelArguments(job) && (await livenessProbe.probeFresh(job)) === true;
}

async function cancelViaCompanion(target, job) {
  const script = findCompanionScript();
  if (!script || !(await shouldDelegateCancel(job))) {
    return { handled: false, plugin: null };
  }

  const plugin = await runCompanionCancel({
    script,
    jobId: job.id,
    workspaceRoot: job.workspaceRoot,
    env: companionEnvFor(target.baseDir, { pluginDataStateDir: PLUGIN_DATA_STATE_DIR, samePath }),
  });
  // The state file decides, not the exit code: the plugin may have resolved another state directory.
  const current = findJob(readTargetState(target), target.jobId);
  return { handled: current?.status === "cancelled", plugin, job: current };
}

async function cancelOneJob(body) {
  const target = requireJobTarget(body);
  const job = requireActiveJob(readTargetState(target), target.jobId);

  const delegated = await cancelViaCompanion(target, job);
  if (delegated.handled) {
    return { job: delegated.job, cancelledVia: "plugin", plugin: delegated.plugin };
  }

  const cancelled = await cancelInDashboard(target);
  return { job: cancelled, cancelledVia: "dashboard", plugin: delegated.plugin };
}

function groupStaleJobsByStateFile(records) {
  const groups = new Map();
  for (const record of records.filter((candidate) => candidate.view.stale)) {
    const group = groups.get(record.statePath) ?? {
      statePath: record.statePath,
      dirName: record.dirName,
      repo: record.repo,
      stalePids: new Map(),
    };
    group.stalePids.set(record.sourceJob.id, record.sourceJob.pid);
    groups.set(record.statePath, group);
  }
  return [...groups.values()];
}

// The scan already proved these PIDs dead or foreign; re-inspecting here would run a subprocess under the lock.
function isStillStale(job, stalePids) {
  return (
    isJobRecord(job) &&
    ACTIVE_STATUSES.has(job.status) &&
    stalePids.has(job.id) &&
    stalePids.get(job.id) === job.pid
  );
}

async function cancelJobsStillStale(statePath, stalePids) {
  const state = readStateFile(statePath);
  if (!state) {
    return [];
  }

  const jobs = state.jobs.filter((job) => isStillStale(job, stalePids));
  if (jobs.length === 0) {
    return [];
  }

  const timestamp = new Date().toISOString();
  const replacements = new Map(jobs.map((job) => [job, cancelledJob(job, timestamp)]));
  const nextState = { ...state, jobs: state.jobs.map((job) => replacements.get(job) ?? job) };
  await writeStateAtomic(statePath, nextState);
  return [...replacements.values()];
}

async function purgeStateFile(group) {
  try {
    return await withStateLock(path.dirname(group.statePath), () =>
      cancelJobsStillStale(group.statePath, group.stalePids),
    );
  } catch (error) {
    if (error instanceof StateLockBusyError) {
      return null;
    }
    throw error;
  }
}

async function purgeStaleJobs() {
  const purged = [];
  const skipped = [];

  for (const group of groupStaleJobsByStateFile(await scanAllJobRecords())) {
    const jobs = await purgeStateFile(group);
    if (jobs === null) {
      skipped.push({ dirName: group.dirName, repo: group.repo, reason: "state file locked" });
      continue;
    }

    for (const job of jobs) {
      // A stale PID is dead or belongs to an unrelated process, so purging never kills anything.
      await bestEffortMergeIntoJobFile(path.dirname(group.statePath), job);
      bestEffortAppendCancellationLog(job, job.completedAt);
      purged.push({ dirName: group.dirName, jobId: job.id, repo: group.repo });
    }
  }

  return { purged, skipped };
}

function bestEffortDeleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing or inaccessible job sidecar files do not fail the delete request.
  }
}

function removeFinishedJob(state, jobId) {
  const jobIndex = state.jobs.findIndex(
    (job) => job && typeof job === "object" && job.id === jobId,
  );

  if (jobIndex === -1) {
    throw new HttpError(404, "Job not found.");
  }

  const job = state.jobs[jobIndex];
  if (ACTIVE_STATUSES.has(job.status)) {
    throw new HttpError(400, "This job is running or queued; cancel it first.");
  }

  state.jobs.splice(jobIndex, 1);
}

async function deleteOneJob(body) {
  const target = requireJobTarget(body);
  await mutateTargetState(target, (state) => removeFinishedJob(state, target.jobId));

  const jobsDir = path.join(target.baseDir, target.dirName, "jobs");
  bestEffortDeleteFile(path.join(jobsDir, `${target.jobId}.log`));
  bestEffortDeleteFile(path.join(jobsDir, `${target.jobId}.json`));

  return target.jobId;
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
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function sendHtml(response) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(HTML_PAGE),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
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
          await requestJson(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          setConnection(successMessage, false);
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

      purgeElement.addEventListener("click", function () {
        var staleCount = dashboard.jobs.filter(function (job) {
          return job.stale === true;
        }).length;
        if (staleCount === 0) {
          return;
        }
        if (window.confirm("Cancel " + staleCount + " stale job(s)?")) {
          runMutation(
            "/api/jobs/purge-stale",
            undefined,
            "Purged " + staleCount + " stale job(s)."
          );
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

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", `http://${HOST}`);
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/") {
    sendHtml(response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/jobs") {
    const jobs = (await scanAllJobRecords()).map((record) => record.view);
    sendJson(response, 200, { jobs });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/cancel") {
    const body = await readJsonBody(request);
    const cancellation = await cancelOneJob(body);
    sendJson(response, 200, { ok: true, ...cancellation });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/purge-stale") {
    const { purged, skipped } = await purgeStaleJobs();
    sendJson(response, 200, { ok: true, purged, skipped });
    return;
  }

  if (request.method === "POST" && pathname === "/api/jobs/delete") {
    const body = await readJsonBody(request);
    const deleted = await deleteOneJob(body);
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
    "Cache-Control": "no-store",
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

const port = parsePort(process.argv.slice(2));
const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    const statusCode = errorStatusCode(error);
    const message = error instanceof Error ? error.message : String(error);

    if (!response.headersSent) {
      sendJson(response, statusCode, { error: message });
    } else if (!response.writableEnded) {
      response.end();
    }
  });
});

server.listen(port, HOST, () => {
  const url = `http://${HOST}:${port}`;
  console.log(`Codex Dashboard running at ${url}`);

  if (process.platform === "win32") {
    try {
      exec(`start "" "${url}"`, { windowsHide: true }, () => {});
    } catch {
      // Auto-opening the browser is a convenience and must never crash the server.
    }
  }
});
