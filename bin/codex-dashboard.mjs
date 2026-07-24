#!/usr/bin/env node
// Displays Codex Companion job status across all local repositories.
// Run: codex-dashboard [--watch|--json]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const BASE_DIRS = [
  process.env.CODEX_COMPANION_STATE_DIR,
  path.join(os.homedir(), ".claude", "plugins", "data", "codex-openai-codex", "state"),
  path.join(os.tmpdir(), "codex-companion"),
].filter(Boolean);
const ACTIVE_STATUSES = new Set(["running", "queued"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STATUS_COLORS = {
  running: "\x1b[33m",
  queued: "\x1b[33m",
  completed: "\x1b[32m",
  failed: "\x1b[31m",
  cancelled: "\x1b[90m",
};
const RESET_COLOR = "\x1b[0m";

function parseTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function jobStartTimestamp(job) {
  return parseTimestamp(job.startedAt ?? job.createdAt);
}

function formatStarted(job) {
  const timestamp = jobStartTimestamp(job);
  if (timestamp === null) {
    return "-";
  }

  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
}

function formatSpan(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

function formatElapsedOrDuration(job, now) {
  const start = jobStartTimestamp(job);
  if (start === null) {
    return "-";
  }

  if (ACTIVE_STATUSES.has(job.status)) {
    return formatSpan(now - start);
  }

  const end = parseTimestamp(job.completedAt ?? job.updatedAt);
  return end === null ? "-" : formatSpan(end - start);
}

function truncateTitle(value) {
  const title = typeof value === "string" ? value : "";
  return title.length > 50 ? `${title.slice(0, 49)}…` : title;
}

function descendingTimestamp(left, right, field) {
  const leftTime = parseTimestamp(left[field]) ?? Number.NEGATIVE_INFINITY;
  const rightTime = parseTimestamp(right[field]) ?? Number.NEGATIVE_INFINITY;
  return rightTime - leftTime;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function colorizeStatus(status, width) {
  const padded = status.toUpperCase().padEnd(width);
  const color = STATUS_COLORS[status];
  return color ? `${color}${padded}${RESET_COLOR}` : padded;
}

async function readJobsFromBaseDir(baseDir) {
  let entries;
  try {
    entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    try {
      const statePath = path.join(baseDir, entry.name, "state.json");
      const state = JSON.parse(await fs.promises.readFile(statePath, "utf8"));
      if (!Array.isArray(state.jobs)) {
        continue;
      }

      const repo = entry.name.replace(/-[0-9a-f]{16}$/, "");
      for (const job of state.jobs) {
        if (job && typeof job === "object" && !Array.isArray(job)) {
          jobs.push({ ...job, repo });
        }
      }
    } catch {
      // Missing, unreadable, and malformed state files are intentionally skipped.
    }
  }

  return jobs;
}

async function readAllJobs() {
  const perDir = await Promise.all(BASE_DIRS.map(readJobsFromBaseDir));
  const seen = new Set();
  const jobs = [];
  for (const job of perDir.flat()) {
    const key = `${job.repo}:${job.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    jobs.push(job);
  }
  return jobs;
}

function buildTable(jobs) {
  const activeJobs = jobs
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .sort((left, right) => descendingTimestamp(left, right, "startedAt"));
  const finishedJobs = jobs
    .filter((job) => FINISHED_STATUSES.has(job.status))
    .sort((left, right) => descendingTimestamp(left, right, "updatedAt"))
    .slice(0, 20);
  const displayedJobs = [...activeJobs, ...finishedJobs];
  const activeRepos = new Set(activeJobs.map((job) => job.repo)).size;
  const summary =
    `${activeJobs.length} ${plural(activeJobs.length, "job")} running across ` +
    `${activeRepos} ${plural(activeRepos, "repo")}`;
  const now = Date.now();
  const headers = [
    "REPO",
    "STATUS",
    "JOB ID",
    "KIND",
    "STARTED",
    "ELAPSED/DURATION",
    "TITLE",
  ];
  const rows = displayedJobs.map((job) => [
    String(job.repo ?? "-"),
    String(job.status ?? "-"),
    String(job.id ?? "-"),
    String(job.kindLabel || job.kind || job.jobClass || "-"),
    formatStarted(job),
    formatElapsedOrDuration(job, now),
    truncateTitle(job.title),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const formatRow = (row, colorStatus = false) =>
    row
      .map((value, index) => {
        if (index === 1 && colorStatus) {
          return colorizeStatus(value, widths[index]);
        }
        return value.padEnd(widths[index]);
      })
      .join(" | ");

  return [
    summary,
    formatRow(headers),
    separator,
    ...rows.map((row) => formatRow(row, true)),
  ].join("\n");
}

async function renderTable() {
  const jobs = await readAllJobs();
  if (jobs.length === 0) {
    process.stdout.write("No Codex Companion jobs found on this machine yet.\n");
    return;
  }

  process.stdout.write(`${buildTable(jobs)}\n`);
}

async function main() {
  const useJson = process.argv.includes("--json");
  const useWatch = process.argv.includes("--watch");

  if (useJson) {
    const jobs = await readAllJobs();
    process.stdout.write(`${JSON.stringify(jobs, null, 2)}\n`);
    return;
  }

  if (!useWatch) {
    await renderTable();
    return;
  }

  while (true) {
    process.stdout.write("\x1Bc");
    await renderTable();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

await main();
