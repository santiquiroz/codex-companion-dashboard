import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildJob,
  createSandbox,
  postJson,
  sandboxEnv,
  startServer,
  stopServer,
  writeStateFixture,
} from "./helpers/server-sandbox.mjs";

const execFileAsync = promisify(execFile);
const CLI_SCRIPT = fileURLToPath(new URL("../bin/codex-dashboard.mjs", import.meta.url));
const OVERRIDE_REPO_DIR = "override-repo-00112233445566ff";
const OTHER_PLUGIN_REPO_DIR = "inline-repo-aabbccddeeff0011";

function writeRepoState(stateDir, dirName, jobs) {
  const repoDir = path.join(stateDir, dirName);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "state.json"), JSON.stringify({ jobs }), "utf8");
}

function otherPluginStateDir(sandbox) {
  return path.join(sandbox.home, ".claude", "plugins", "data", "codex-inline", "state");
}

async function runCliJson(sandbox, extraEnv) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_SCRIPT, "--json"], {
    env: sandboxEnv(sandbox, extraEnv),
    windowsHide: true,
  });
  return JSON.parse(stdout);
}

async function fetchServerJobs(sandbox, extraEnv) {
  const server = await startServer(sandbox, extraEnv);
  try {
    const response = await fetch(`${server.url}/api/jobs`);
    return (await response.json()).jobs;
  } finally {
    await stopServer(server);
  }
}

function jobKeys(jobs) {
  return jobs.map((job) => `${job.repo}:${job.id}`);
}

describe("state directory discovery shared by the CLI and the GUI", () => {
  let sandbox;
  let overrideDir;
  let overrideEnv;

  before(() => {
    sandbox = createSandbox();
    overrideDir = path.join(sandbox.root, "override-state");
    overrideEnv = { CODEX_COMPANION_STATE_DIR: overrideDir };
    writeStateFixture(sandbox, [buildJob({ id: "temp-1", status: "completed" })]);
    writeRepoState(otherPluginStateDir(sandbox), OTHER_PLUGIN_REPO_DIR, [
      buildJob({ id: "inline-1", status: "failed" }),
    ]);
    writeRepoState(overrideDir, OVERRIDE_REPO_DIR, [
      buildJob({ id: "over-done", status: "completed" }),
      buildJob({ id: "over-queued", status: "queued" }),
    ]);
  });

  after(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("with CODEX_COMPANION_STATE_DIR the CLI lists only the override jobs", async () => {
    const jobs = await runCliJson(sandbox, overrideEnv);

    assert.deepEqual(jobKeys(jobs), ["override-repo:over-done", "override-repo:over-queued"]);
  });

  test("with CODEX_COMPANION_STATE_DIR the GUI lists the same jobs as the CLI", async () => {
    const cliJobs = await runCliJson(sandbox, overrideEnv);
    const guiJobs = await fetchServerJobs(sandbox, overrideEnv);

    assert.deepEqual(jobKeys(guiJobs), jobKeys(cliJobs));
    assert.ok(guiJobs.every((job) => job.baseDir === overrideDir));
  });

  test("the GUI accepts a cancel on the override baseDir", async () => {
    const server = await startServer(sandbox, overrideEnv);
    try {
      const result = await postJson(`${server.url}/api/jobs/cancel`, {
        baseDir: overrideDir,
        dirName: OVERRIDE_REPO_DIR,
        jobId: "over-queued",
      });

      assert.equal(result.status, 200);
      assert.equal(result.payload.job.status, "cancelled");
    } finally {
      await stopServer(server);
    }
  });

  test("without the variable both discover state under another plugin data id", async () => {
    const cliJobs = await runCliJson(sandbox);
    const guiJobs = await fetchServerJobs(sandbox);

    assert.deepEqual(jobKeys(cliJobs), ["inline-repo:inline-1", "demo-repo:temp-1"]);
    assert.deepEqual(jobKeys(guiJobs), jobKeys(cliJobs));
  });
});
