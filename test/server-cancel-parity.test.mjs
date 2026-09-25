import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { spawnTaskWorker, stopChild, waitForExit } from "./helpers/fake-processes.mjs";
import {
  buildJob,
  createSandbox,
  jobTarget,
  postJson,
  readState,
  startServer,
  stopServer,
  writeStateFixture,
} from "./helpers/server-sandbox.mjs";

const JOB_ID = "task-demo-1";
const DEAD_PID = 99999999;
const EXIT_WAIT_MS = 5_000;
const PLUGIN_MESSAGE = "Cancelled by user.";
const DASHBOARD_MESSAGE = "Cancelled via dashboard.";

// Stands in for the plugin's codex-companion.mjs: records how it was called, then cancels or fails.
const FAKE_PLUGIN_SCRIPT = `import fs from "node:fs";
fs.writeFileSync(process.env.FAKE_CANCEL_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  pluginData: process.env.CLAUDE_PLUGIN_DATA ?? null,
}));
if (process.env.FAKE_CANCEL_MODE === "fail") {
  process.stderr.write("No active job found.");
  process.exit(1);
}
const jobId = process.argv[3];
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE_PATH, "utf8"));
state.jobs = state.jobs.map((job) => job.id === jobId
  ? { ...job, status: "cancelled", phase: "cancelled", pid: null, errorMessage: ${JSON.stringify(PLUGIN_MESSAGE)} }
  : job);
fs.writeFileSync(process.env.FAKE_STATE_PATH, JSON.stringify(state));
process.stdout.write(JSON.stringify({ jobId, status: "cancelled", turnInterruptAttempted: true, turnInterrupted: true }));
`;

function writeFakePlugin(sandbox) {
  const scriptPath = path.join(sandbox.root, "fake-plugin", "codex-companion.mjs");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, FAKE_PLUGIN_SCRIPT, "utf8");
  return scriptPath;
}

function prepareSandbox() {
  const sandbox = createSandbox();
  const workspaceRoot = path.join(sandbox.root, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return { ...sandbox, workspaceRoot, cancelLog: path.join(sandbox.root, "cancel-call.json") };
}

function fakePluginEnv(sandbox, mode) {
  return {
    CODEX_COMPANION_SCRIPT: writeFakePlugin(sandbox),
    FAKE_CANCEL_LOG: sandbox.cancelLog,
    FAKE_CANCEL_MODE: mode,
    FAKE_STATE_PATH: sandbox.statePath,
  };
}

function jobFilePath(sandbox) {
  return path.join(sandbox.repoDir, "jobs", `${JOB_ID}.json`);
}

function writeRunningJob(sandbox, pid) {
  const job = buildJob({
    id: JOB_ID,
    status: "running",
    phase: "running",
    pid,
    workspaceRoot: sandbox.workspaceRoot,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  writeStateFixture(sandbox, [job]);
  fs.writeFileSync(jobFilePath(sandbox), JSON.stringify({ ...job, request: "original prompt" }), "utf8");
}

function readJobFile(sandbox) {
  return JSON.parse(fs.readFileSync(jobFilePath(sandbox), "utf8"));
}

function stateJob(sandbox) {
  return readState(sandbox).jobs.find((job) => job.id === JOB_ID);
}

function readCancelCall(sandbox) {
  return fs.existsSync(sandbox.cancelLog) ? JSON.parse(fs.readFileSync(sandbox.cancelLog, "utf8")) : null;
}

function assertCancelledByDashboard(job) {
  assert.equal(job.status, "cancelled");
  assert.equal(job.phase, "cancelled");
  assert.equal(job.pid, null);
  assert.equal(job.errorMessage, DASHBOARD_MESSAGE);
  assert.equal(typeof job.cancelledAt, "string");
  assert.equal(job.completedAt, job.cancelledAt);
}

function cleanUp(server, sandbox) {
  return stopServer(server).then(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
}

describe("GUI cancel delegates live jobs to the plugin's cancel command", () => {
  let sandbox;
  let server;

  before(async () => {
    sandbox = prepareSandbox();
    server = await startServer(sandbox, fakePluginEnv(sandbox, "cancel"));
  });

  after(() => cleanUp(server, sandbox));

  test("invokes `cancel <id> --cwd <workspaceRoot> --json` and keeps the plugin's result", async (t) => {
    const worker = spawnTaskWorker(sandbox, JOB_ID);
    t.after(() => stopChild(worker));
    writeRunningJob(sandbox, worker.pid);

    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));
    const call = readCancelCall(sandbox);

    assert.equal(cancel.status, 200);
    assert.deepEqual(call.argv, ["cancel", JOB_ID, "--cwd", sandbox.workspaceRoot, "--json"]);
    assert.equal(call.pluginData, null, "a temp-dir state root must not point the plugin at CLAUDE_PLUGIN_DATA");
    assert.equal(cancel.payload.cancelledVia, "plugin");
    assert.equal(cancel.payload.plugin.result.turnInterrupted, true);
    assert.equal(stateJob(sandbox).errorMessage, PLUGIN_MESSAGE, "the dashboard must not overwrite the plugin's cancel");
  });
});

describe("GUI cancel falls back to its own cancel when the plugin cannot cancel", () => {
  let sandbox;
  let server;

  before(async () => {
    sandbox = prepareSandbox();
    server = await startServer(sandbox, fakePluginEnv(sandbox, "fail"));
  });

  after(() => cleanUp(server, sandbox));

  test("a failing plugin cancel still cancels state.json and jobs/<id>.json and stops the worker", async (t) => {
    const worker = spawnTaskWorker(sandbox, JOB_ID);
    t.after(() => stopChild(worker));
    writeRunningJob(sandbox, worker.pid);

    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));

    assert.equal(cancel.status, 200);
    assert.notEqual(readCancelCall(sandbox), null, "the plugin must have been tried first");
    assert.equal(cancel.payload.cancelledVia, "dashboard");
    assertCancelledByDashboard(stateJob(sandbox));
    assertCancelledByDashboard(readJobFile(sandbox));
    assert.equal(await waitForExit(worker, EXIT_WAIT_MS), true, "the verified worker must be terminated");
  });
});

describe("GUI cancel without the plugin script", () => {
  let sandbox;
  let server;

  before(async () => {
    sandbox = prepareSandbox();
    server = await startServer(sandbox, {
      CODEX_COMPANION_SCRIPT: path.join(sandbox.root, "missing", "codex-companion.mjs"),
    });
  });

  after(() => cleanUp(server, sandbox));

  test("cancels state.json and merges the cancellation into jobs/<id>.json", async (t) => {
    const worker = spawnTaskWorker(sandbox, JOB_ID);
    t.after(() => stopChild(worker));
    writeRunningJob(sandbox, worker.pid);

    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));
    const jobFile = readJobFile(sandbox);

    assert.equal(cancel.status, 200);
    assert.equal(cancel.payload.cancelledVia, "dashboard");
    assertCancelledByDashboard(stateJob(sandbox));
    assertCancelledByDashboard(jobFile);
    assert.equal(jobFile.request, "original prompt", "the job file is merged, not replaced");
    assert.equal(jobFile.threadId, "thread-1");
  });

  test("purging a stale job also updates jobs/<id>.json", async () => {
    writeRunningJob(sandbox, DEAD_PID);

    const purge = await postJson(`${server.url}/api/jobs/purge-stale`);

    assert.equal(purge.status, 200);
    assert.deepEqual(purge.payload.purged.map((entry) => entry.jobId), [JOB_ID]);
    assertCancelledByDashboard(stateJob(sandbox));
    assertCancelledByDashboard(readJobFile(sandbox));
  });

  test("a job file that does not exist is not created", async () => {
    writeRunningJob(sandbox, DEAD_PID);
    fs.rmSync(jobFilePath(sandbox));

    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));

    assert.equal(cancel.status, 200);
    assert.equal(fs.existsSync(jobFilePath(sandbox)), false);
  });
});
