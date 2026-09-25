import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = fileURLToPath(new URL("../bin/codex-dashboard-server.mjs", import.meta.url));
const REPO_DIR_NAME = "demo-repo-0123456789abcdef";
// Never a live process: odd PIDs do not exist on Windows and it exceeds Linux pid_max.
const DEAD_PID = 99_999_999;
const STALE_LOCK_AGE_MS = 10_000;

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-state-writes-"));
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  const baseDir = path.join(temp, "codex-companion");
  const repoDir = path.join(baseDir, REPO_DIR_NAME);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(repoDir, "jobs"), { recursive: true });
  return { root, home, temp, baseDir, repoDir, statePath: path.join(repoDir, "state.json") };
}

function sandboxEnv(sandbox) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(comspec|userprofile|home|temp|tmp|tmpdir)$/i.test(key)),
  );
  // An unusable shell makes the server's Windows "start <url>" fail instead of opening a browser.
  env.ComSpec = path.join(sandbox.root, "no-shell.exe");
  env.USERPROFILE = sandbox.home;
  env.HOME = sandbox.home;
  env.TEMP = sandbox.temp;
  env.TMP = sandbox.temp;
  env.TMPDIR = sandbox.temp;
  return env;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Codex Dashboard running at")) {
        resolve();
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
  });
}

async function startServer(sandbox) {
  const port = await findFreePort();
  const child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(port)], {
    env: sandboxEnv(sandbox),
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  await waitForListening(child);
  return { child, url: `http://127.0.0.1:${port}` };
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server.child.exitCode !== null) {
      resolve();
      return;
    }
    server.child.once("exit", () => resolve());
    server.child.kill();
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, payload: await response.json() };
}

function buildJob(overrides) {
  return {
    id: "task-demo-1",
    status: "queued",
    phase: "queued",
    title: "Demo job",
    pid: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function writeStateFixture(sandbox, jobs) {
  const text = `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`;
  fs.writeFileSync(sandbox.statePath, text, "utf8");
  return text;
}

function readState(sandbox) {
  return JSON.parse(fs.readFileSync(sandbox.statePath, "utf8"));
}

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

function jobTarget(sandbox, jobId) {
  return { baseDir: sandbox.baseDir, dirName: REPO_DIR_NAME, jobId };
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
