import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildJob, createSandbox, sandboxEnv, writeStateFixture } from "./helpers/server-sandbox.mjs";

const execFileAsync = promisify(execFile);
const CLI_SCRIPT = fileURLToPath(new URL("../bin/codex-dashboard.mjs", import.meta.url));
const PLUGIN_REPO_DIR = "plugin-repo-fedcba9876543210";

function writePluginDataState(sandbox, jobs) {
  const repoDir = path.join(
    sandbox.home, ".claude", "plugins", "data", "codex-openai-codex", "state", PLUGIN_REPO_DIR,
  );
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "state.json"), JSON.stringify({ jobs }), "utf8");
}

async function runCli(sandbox, args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_SCRIPT, ...args], {
    env: sandboxEnv(sandbox),
    windowsHide: true,
  });
  return stdout;
}

describe("codex-dashboard over sandboxed fixtures", () => {
  let sandbox;

  before(() => {
    sandbox = createSandbox();
    writePluginDataState(sandbox, [buildJob({ id: "p1", status: "running" }), "not-a-job"]);
    writeStateFixture(sandbox, [buildJob({ id: "t1", status: "completed" })]);
  });

  after(() => {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });

  test("--json prints every job from both default state directories with its repo", async () => {
    const jobs = JSON.parse(await runCli(sandbox, ["--json"]));

    assert.deepEqual(
      jobs.map((job) => [job.repo, job.id, job.status]),
      [
        ["plugin-repo", "p1", "running"],
        ["demo-repo", "t1", "completed"],
      ],
    );
    assert.deepEqual(jobs[1], { ...buildJob({ id: "t1", status: "completed" }), repo: "demo-repo" });
  });

  test("without flags prints the table with a summary line", async () => {
    const [summary] = (await runCli(sandbox, [])).split("\n");

    assert.equal(summary, "1 job running across 1 repo");
  });
});
