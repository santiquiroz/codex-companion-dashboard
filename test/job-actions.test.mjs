import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";

import { COMPANION_SCRIPT_ENV } from "../lib/companion-cancel.mjs";
import { createJobActions } from "../lib/job-actions.mjs";
import { buildJob, createSandbox, jobTarget, readState, writeStateFixture } from "./helpers/server-sandbox.mjs";

const JOB_ID = "task-demo-1";
const FAKE_PID = 4242;

function verifiedLiveProbe() {
  return { probe: async () => true, probeFresh: async () => true };
}

function writeRunningJob(sandbox) {
  writeStateFixture(sandbox, [buildJob({ id: JOB_ID, status: "running", phase: "running", pid: FAKE_PID })]);
}

describe("dashboard cancel of a verified live worker", () => {
  let sandbox;
  let previousScript;

  before(() => {
    sandbox = createSandbox();
    previousScript = process.env[COMPANION_SCRIPT_ENV];
    // A missing explicit override disables delegation to any installed plugin.
    process.env[COMPANION_SCRIPT_ENV] = path.join(sandbox.root, "missing-plugin.mjs");
  });

  after(() => {
    if (previousScript === undefined) {
      delete process.env[COMPANION_SCRIPT_ENV];
    } else {
      process.env[COMPANION_SCRIPT_ENV] = previousScript;
    }
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("kills the worker before recording the cancellation, like the plugin", async () => {
    writeRunningJob(sandbox);
    const statusAtKill = [];
    const actions = createJobActions({
      baseDirs: [sandbox.baseDir],
      livenessProbe: verifiedLiveProbe(),
      kill: (pid) => statusAtKill.push({ pid, status: readState(sandbox).jobs[0].status }),
    });

    const result = await actions.cancelJob(jobTarget(sandbox, JOB_ID));

    assert.deepEqual(statusAtKill, [{ pid: FAKE_PID, status: "running" }]);
    assert.equal(result.cancelledVia, "dashboard");
    assert.equal(readState(sandbox).jobs[0].status, "cancelled");
  });
});
