import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  REPO_DIR_NAME,
  buildJob,
  createSandbox,
  jobTarget,
  postJson,
  startServer,
  stopServer,
  writeStateFixture,
} from "./helpers/server-sandbox.mjs";

const JOB_ID = "task-demo-1";
const IDLE_SCRIPT = "setInterval(() => {}, 1000);\n";
const EXIT_WAIT_MS = 5_000;
const SURVIVAL_WAIT_MS = 500;
const WINDOWS_SYSTEM_PID = 4;

function writeFakeCompanionScript(sandbox) {
  const scriptPath = path.join(sandbox.root, "scripts", "codex-companion.mjs");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, IDLE_SCRIPT, "utf8");
  return scriptPath;
}

function spawnIdleProcess(args) {
  return spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
}

function spawnForeignProcess() {
  return spawnIdleProcess(["-e", IDLE_SCRIPT]);
}

function spawnTaskWorker(sandbox, jobId) {
  const scriptPath = writeFakeCompanionScript(sandbox);
  return spawnIdleProcess([scriptPath, "task-worker", "--cwd", sandbox.root, "--job-id", jobId]);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

function stopChild(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
  }
}

function writeRunningJob(sandbox, pid) {
  writeStateFixture(sandbox, [buildJob({ id: JOB_ID, status: "running", phase: "running", pid })]);
}

async function fetchJobView(serverUrl) {
  const response = await fetch(`${serverUrl}/api/jobs`);
  const { jobs } = await response.json();
  return jobs.find((job) => job.dirName === REPO_DIR_NAME && job.id === JOB_ID);
}

describe("dashboard verifies the process identity before trusting or killing a PID", () => {
  let sandbox;
  let server;

  before(async () => {
    sandbox = createSandbox();
    server = await startServer(sandbox);
  });

  after(async () => {
    await stopServer(server);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("a live PID running a foreign command line is stale and cancel leaves it running", async (t) => {
    const foreign = spawnForeignProcess();
    t.after(() => stopChild(foreign));
    writeRunningJob(sandbox, foreign.pid);

    const view = await fetchJobView(server.url);
    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));

    assert.equal(view.alive, false);
    assert.equal(view.stale, true);
    assert.equal(cancel.status, 200);
    assert.equal(await waitForExit(foreign, SURVIVAL_WAIT_MS), false, "a foreign process must not be killed");
  });

  test("a task-worker started for another job is stale and is not killed", async (t) => {
    const otherWorker = spawnTaskWorker(sandbox, "task-other-job");
    t.after(() => stopChild(otherWorker));
    writeRunningJob(sandbox, otherWorker.pid);

    const view = await fetchJobView(server.url);
    await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));

    assert.equal(view.stale, true);
    assert.equal(await waitForExit(otherWorker, SURVIVAL_WAIT_MS), false);
  });

  test(
    "a live PID whose command line cannot be read is unknown, not stale",
    { skip: process.platform !== "win32" && "the System process only exists on Windows" },
    async () => {
      // The System process always exists and never exposes a command line; the test only reads.
      writeRunningJob(sandbox, WINDOWS_SYSTEM_PID);

      const view = await fetchJobView(server.url);

      assert.equal(view.alive, null);
      assert.equal(view.stale, false);
    },
  );

  test("the job's own task-worker is alive and cancel kills it", async (t) => {
    const worker = spawnTaskWorker(sandbox, JOB_ID);
    t.after(() => stopChild(worker));
    writeRunningJob(sandbox, worker.pid);

    const view = await fetchJobView(server.url);
    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, JOB_ID));

    assert.equal(view.alive, true);
    assert.equal(view.stale, false);
    assert.equal(cancel.status, 200);
    assert.equal(await waitForExit(worker, EXIT_WAIT_MS), true, "the job's worker must be terminated");
  });
});
