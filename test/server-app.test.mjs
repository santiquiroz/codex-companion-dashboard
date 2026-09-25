import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createServer, parseServerArgs } from "../bin/codex-dashboard-server.mjs";
import {
  REPO_DIR_NAME,
  SERVER_SCRIPT,
  buildJob,
  createSandbox,
  jobTarget,
  postJson,
  readState,
  sandboxEnv,
  startServer,
  stopServer,
  writeStateFixture,
} from "./helpers/server-sandbox.mjs";

const execFileAsync = promisify(execFile);
// Never a live process: odd PIDs do not exist on Windows and it exceeds Linux pid_max.
const DEAD_PID = 99_999_999;
const IMPORT_TIMEOUT_MS = 10_000;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function writeJobSidecars(sandbox, jobId) {
  const jobsDir = path.join(sandbox.repoDir, "jobs");
  fs.writeFileSync(path.join(jobsDir, `${jobId}.json`), "{}", "utf8");
  fs.writeFileSync(path.join(jobsDir, `${jobId}.log`), "log", "utf8");
  return jobsDir;
}

describe("createServer serves the injected state directories without opening a browser", () => {
  let sandbox;
  let server;
  let url;
  const launched = [];

  before(async () => {
    sandbox = createSandbox();
    server = createServer({
      baseDirs: [sandbox.baseDir],
      openBrowser: false,
      launchBrowser: (target) => launched.push(target),
    });
    url = await listen(server);
  });

  after(async () => {
    await close(server);
    fs.rmSync(sandbox.root, { recursive: true, force: true });
    assert.deepEqual(launched, [], "openBrowser: false must never launch a browser");
  });

  test("GET /api/jobs lists the fixture jobs with their location and liveness", async () => {
    writeStateFixture(sandbox, [
      buildJob({ id: "done-1", status: "completed", phase: "done" }),
      buildJob({ id: "run-1", status: "running", phase: "running", pid: DEAD_PID }),
    ]);

    const response = await fetch(`${url}/api/jobs`);
    const { jobs } = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(
      jobs.map((job) => [job.id, job.repo, job.dirName, job.baseDir, job.alive, job.stale]),
      [
        ["done-1", "demo-repo", REPO_DIR_NAME, sandbox.baseDir, null, false],
        ["run-1", "demo-repo", REPO_DIR_NAME, sandbox.baseDir, false, true],
      ],
    );
  });

  test("POST /api/jobs/delete answers 404 for a job that does not exist", async () => {
    writeStateFixture(sandbox, [buildJob({ id: "done-1", status: "completed" })]);

    const result = await postJson(`${url}/api/jobs/delete`, jobTarget(sandbox, "missing-job"));

    assert.equal(result.status, 404);
  });

  test("POST /api/jobs/delete answers 400 for a dirName of '..'", async () => {
    const result = await postJson(`${url}/api/jobs/delete`, { ...jobTarget(sandbox, "done-1"), dirName: ".." });

    assert.equal(result.status, 400);
  });

  test("POST /api/jobs/delete answers 400 for a baseDir outside the injected ones", async () => {
    const result = await postJson(`${url}/api/jobs/delete`, {
      ...jobTarget(sandbox, "done-1"),
      baseDir: path.join(sandbox.temp, "elsewhere"),
    });

    assert.equal(result.status, 400);
  });

  test("POST /api/jobs/delete answers 400 and keeps an active job", async () => {
    writeStateFixture(sandbox, [buildJob({ id: "run-1", status: "running", pid: DEAD_PID })]);

    const result = await postJson(`${url}/api/jobs/delete`, jobTarget(sandbox, "run-1"));

    assert.equal(result.status, 400);
    assert.deepEqual(readState(sandbox).jobs.map((job) => job.id), ["run-1"]);
  });

  test("POST /api/jobs/delete removes a finished job and its sidecar files", async () => {
    writeStateFixture(sandbox, [
      buildJob({ id: "done-1", status: "completed" }),
      buildJob({ id: "keep-1", status: "failed" }),
    ]);
    const jobsDir = writeJobSidecars(sandbox, "done-1");

    const result = await postJson(`${url}/api/jobs/delete`, jobTarget(sandbox, "done-1"));

    assert.equal(result.status, 200);
    assert.equal(result.payload.deleted, "done-1");
    assert.deepEqual(readState(sandbox).jobs.map((job) => job.id), ["keep-1"]);
    assert.deepEqual(fs.readdirSync(jobsDir), []);
  });

  test("unknown API routes answer 404 JSON and other paths 404 text", async () => {
    const api = await fetch(`${url}/api/nope`);
    const page = await fetch(`${url}/nope`);

    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: "API route not found." });
    assert.equal(page.status, 404);
    assert.equal(await page.text(), "Not found\n");
  });

  test("GET / serves the dashboard page", async () => {
    const response = await fetch(`${url}/`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(await response.text(), /<!doctype html>/i);
  });
});

describe("createServer browser launching", () => {
  test("opens the listening URL once when openBrowser is true", async () => {
    const launched = [];
    const server = createServer({
      baseDirs: [],
      openBrowser: true,
      launchBrowser: (target) => launched.push(target),
    });

    const url = await listen(server);
    await close(server);

    assert.deepEqual(launched, [url]);
  });
});

describe("server command line", () => {
  test("parseServerArgs defaults to port 4317 and opening the browser", () => {
    assert.deepEqual(parseServerArgs([]), { port: 4317, openBrowser: true });
  });

  test("parseServerArgs accepts --port 0 and --no-open", () => {
    assert.deepEqual(parseServerArgs(["--port", "0", "--no-open"]), { port: 0, openBrowser: false });
  });

  test("parseServerArgs rejects ports outside 0-65535 and non-integers", () => {
    for (const value of ["-1", "65536", "abc", "1.5"]) {
      assert.throws(() => parseServerArgs(["--port", value]), /--port/);
    }
  });

  test("importing the server module does not start listening", async () => {
    const sandbox = createSandbox();
    try {
      const script = `await import(${JSON.stringify(pathToFileURL(SERVER_SCRIPT).href)}); console.log("imported");`;
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        env: sandboxEnv(sandbox),
        timeout: IMPORT_TIMEOUT_MS,
        windowsHide: true,
      });

      assert.equal(stdout.trim(), "imported");
    } finally {
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  test("the binary with --port 0 --no-open reports the port it actually bound", async () => {
    const sandbox = createSandbox();
    const server = await startServer(sandbox);
    try {
      const response = await fetch(`${server.url}/api/jobs`);

      assert.notEqual(new URL(server.url).port, "0");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { jobs: [] });
    } finally {
      await stopServer(server);
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
});
