import { ACTIVE_STATUSES, FINISHED_STATUSES } from "./job-records.mjs";

const STATUS_COLORS = {
  running: "\x1b[33m",
  queued: "\x1b[33m",
  completed: "\x1b[32m",
  failed: "\x1b[31m",
  cancelled: "\x1b[90m",
};
const RESET_COLOR = "\x1b[0m";
const MAX_FINISHED_ROWS = 20;
const MAX_TITLE_LENGTH = 50;
const HEADERS = ["REPO", "STATUS", "JOB ID", "KIND", "STARTED", "ELAPSED/DURATION", "TITLE"];
const STATUS_COLUMN = 1;

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

export function formatSpan(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours >= 1 ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

export function formatElapsedOrDuration(job, now) {
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
  return title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;
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

function selectDisplayedJobs(jobs) {
  const activeJobs = jobs
    .filter((job) => ACTIVE_STATUSES.has(job.status))
    .sort((left, right) => descendingTimestamp(left, right, "startedAt"));
  const finishedJobs = jobs
    .filter((job) => FINISHED_STATUSES.has(job.status))
    .sort((left, right) => descendingTimestamp(left, right, "updatedAt"))
    .slice(0, MAX_FINISHED_ROWS);
  return { activeJobs, displayedJobs: [...activeJobs, ...finishedJobs] };
}

function summarize(activeJobs) {
  const activeRepos = new Set(activeJobs.map((job) => job.repo)).size;
  return (
    `${activeJobs.length} ${plural(activeJobs.length, "job")} running across ` +
    `${activeRepos} ${plural(activeRepos, "repo")}`
  );
}

function jobRow(job, now) {
  return [
    String(job.repo ?? "-"),
    String(job.status ?? "-"),
    String(job.id ?? "-"),
    String(job.kindLabel || job.kind || job.jobClass || "-"),
    formatStarted(job),
    formatElapsedOrDuration(job, now),
    truncateTitle(job.title),
  ];
}

function formatRow(row, widths, colorStatus) {
  return row
    .map((value, index) =>
      index === STATUS_COLUMN && colorStatus ? colorizeStatus(value, widths[index]) : value.padEnd(widths[index]),
    )
    .join(" | ");
}

export function buildTable(jobs, now = Date.now()) {
  const { activeJobs, displayedJobs } = selectDisplayedJobs(jobs);
  const rows = displayedJobs.map((job) => jobRow(job, now));
  const widths = HEADERS.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");

  return [
    summarize(activeJobs),
    formatRow(HEADERS, widths, false),
    separator,
    ...rows.map((row) => formatRow(row, widths, true)),
  ].join("\n");
}
