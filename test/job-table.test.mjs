import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildTable, formatElapsedOrDuration, formatSpan } from "../lib/job-table.mjs";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function plainLines(table) {
  return table.replace(ANSI_PATTERN, "").split("\n");
}

describe("job table formatting", () => {
  test("formatSpan shows minutes and seconds below an hour, hours and minutes above", () => {
    assert.equal(formatSpan(65_000), "1m 5s");
    assert.equal(formatSpan(3_720_000), "1h 2m");
    assert.equal(formatSpan(-5), "0m 0s");
    assert.equal(formatSpan(Number.NaN), "-");
  });

  test("elapsed time runs to now for active jobs and to completion for finished ones", () => {
    const running = { status: "running", startedAt: "2026-09-01T11:59:00.000Z" };
    const completed = {
      status: "completed",
      startedAt: "2026-09-01T10:00:00.000Z",
      completedAt: "2026-09-01T10:00:30.000Z",
    };

    assert.equal(formatElapsedOrDuration(running, NOW), "1m 0s");
    assert.equal(formatElapsedOrDuration(completed, NOW), "0m 30s");
    assert.equal(formatElapsedOrDuration({ status: "running" }, NOW), "-");
  });

  test("buildTable summarises active jobs and lists them before finished ones", () => {
    const jobs = [
      { repo: "alpha", id: "done-1", status: "completed", updatedAt: "2026-09-01T09:00:00.000Z" },
      { repo: "beta", id: "run-1", status: "running", kind: "task", startedAt: "2026-09-01T11:00:00.000Z" },
      { repo: "alpha", id: "run-2", status: "queued", startedAt: "2026-09-01T11:30:00.000Z" },
    ];

    const [summary, header, , ...rows] = plainLines(buildTable(jobs, NOW));

    assert.equal(summary, "2 jobs running across 2 repos");
    assert.match(header, /^REPO\s+\| STATUS\s+\| JOB ID/);
    assert.deepEqual(
      rows.map((row) => row.split("|")[2].trim()),
      ["run-2", "run-1", "done-1"],
    );
  });

  test("buildTable truncates long titles to 50 characters", () => {
    const title = "x".repeat(80);
    const [, , , row] = plainLines(buildTable([{ repo: "r", id: "j", status: "completed", title }], NOW));

    assert.ok(row.endsWith(`${"x".repeat(49)}…`));
  });
});
