#!/usr/bin/env node
// Displays Codex Companion job status across all local repositories.
// Run: codex-dashboard [--watch|--json]

import process from "node:process";
import { collectJobRecords, uniqueBy } from "../lib/job-records.mjs";
import { buildTable } from "../lib/job-table.mjs";
import { resolveStateDirs } from "../lib/state-dirs.mjs";

const BASE_DIRS = resolveStateDirs();
const WATCH_INTERVAL_MS = 3000;

function readAllJobs() {
  const records = uniqueBy(
    collectJobRecords(BASE_DIRS),
    (record) => `${record.repo}:${record.sourceJob.id}`,
  );
  return records.map((record) => ({ ...record.sourceJob, repo: record.repo }));
}

function renderTable() {
  const jobs = readAllJobs();
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
    process.stdout.write(`${JSON.stringify(readAllJobs(), null, 2)}\n`);
    return;
  }

  if (!useWatch) {
    renderTable();
    return;
  }

  while (true) {
    process.stdout.write("\x1Bc");
    renderTable();
    await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
  }
}

await main();
