import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createSandbox,
  startServer,
  stopServer,
  postJson,
  buildJob,
  writeStateFixture,
  readState,
  jobTarget,
} from "./helpers/server-sandbox.mjs";

// Never a live process: odd PIDs do not exist on Windows and it exceeds Linux pid_max.
const DEAD_PID = 99_999_999;
const STALE_LOCK_AGE_MS = 10_000;

function lockPath(sandbox) {
  return path.join(sandbox.repoDir, "state.lock");
}

function holdFreshLock(sandbox) {
  fs.writeFileSync(lockPath(sandbox), "424242", { flag: "wx" });
}

function holdStaleLock(sandbox) {
  holdFreshLock(sandbox);
  const past = new Date(Date.now() - STALE_LOCK_AGE_MS);
  fs.utimesSync(lockPath(sandbox), past, past);
}

function leftoverTempFiles(sandbox) {
  return fs.readdirSync(sandbox.repoDir).filter((name) => name.startsWith("state.json.tmp-"));
}

describe("dashboard state writes honour the plugin's state.lock", () => {
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

  beforeEach(() => {
    fs.rmSync(lockPath(sandbox), { force: true });
  });

  test("cancel answers 409 and leaves state.json untouched while a fresh lock is held", async () => {
    const original = writeStateFixture(sandbox, [buildJob()]);
    holdFreshLock(sandbox);

    const { status } = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, "task-demo-1"));

    assert.equal(status, 409);
    assert.equal(fs.readFileSync(sandbox.statePath, "utf8"), original);
    assert.ok(fs.existsSync(lockPath(sandbox)), "the other writer's lock must not be removed");
  });

  test("cancel takes over a lock older than 5 s and releases it afterwards", async () => {
    writeStateFixture(sandbox, [buildJob()]);
    holdStaleLock(sandbox);

    const { status } = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, "task-demo-1"));

    assert.equal(status, 200);
    assert.equal(readState(sandbox).jobs[0].status, "cancelled");
    assert.equal(fs.existsSync(lockPath(sandbox)), false);
  });

  test("cancel and delete leave valid JSON and no temporary files behind", async () => {
    writeStateFixture(sandbox, [
      buildJob(),
      buildJob({ id: "task-demo-2", status: "completed", phase: "done" }),
    ]);

    const cancel = await postJson(`${server.url}/api/jobs/cancel`, jobTarget(sandbox, "task-demo-1"));
    const remove = await postJson(`${server.url}/api/jobs/delete`, jobTarget(sandbox, "task-demo-2"));

    assert.equal(cancel.status, 200);
    assert.equal(remove.status, 200);
    assert.deepEqual(
      readState(sandbox).jobs.map((job) => [job.id, job.status]),
      [["task-demo-1", "cancelled"]],
    );
    assert.deepEqual(leftoverTempFiles(sandbox), []);
    assert.equal(fs.existsSync(lockPath(sandbox)), false);
  });

  test("purge does not overwrite a job another writer completed after the scan", async () => {
    writeStateFixture(sandbox, [buildJob({ status: "running", phase: "running", pid: DEAD_PID })]);
    holdFreshLock(sandbox);

    const purge = postJson(`${server.url}/api/jobs/purge-stale`);
    await delay(300);
    const completed = writeStateFixture(sandbox, [
      buildJob({ status: "completed", phase: "done", pid: DEAD_PID }),
    ]);
    fs.rmSync(lockPath(sandbox));
    const { status, payload } = await purge;

    assert.equal(status, 200);
    assert.deepEqual(payload.purged, []);
    assert.equal(fs.readFileSync(sandbox.statePath, "utf8"), completed);
  });
});
