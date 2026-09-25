import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { after, before, describe, test } from "node:test";

import {
  CANCEL_TIMEOUT_MS,
  COMPANION_SCRIPT_ENV,
  cancelArguments,
  companionEnvFor,
  findCompanionScript,
  runCompanionCancel,
} from "../lib/companion-cancel.mjs";

const SCRIPT_TAIL = path.join("scripts", "codex-companion.mjs");

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", "utf8");
  return filePath;
}

function cachedScript(homeDir, version) {
  return path.join(homeDir, ".claude", "plugins", "cache", "openai-codex", "codex", version, SCRIPT_TAIL);
}

function marketplaceScript(homeDir) {
  return path.join(
    homeDir, ".claude", "plugins", "marketplaces", "openai-codex", "plugins", "codex", SCRIPT_TAIL,
  );
}

function freshHome(root, name) {
  const homeDir = path.join(root, name);
  fs.mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

describe("findCompanionScript", () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-companion-"));
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("uses CODEX_COMPANION_SCRIPT when it points to a file", () => {
    const override = touch(path.join(root, "override", "codex-companion.mjs"));

    const found = findCompanionScript({ env: { [COMPANION_SCRIPT_ENV]: override }, homeDir: root });

    assert.equal(found, override);
  });

  test("a missing CODEX_COMPANION_SCRIPT never falls back to the installed plugin", () => {
    const homeDir = freshHome(root, "installed");
    touch(cachedScript(homeDir, "1.0.4"));

    const found = findCompanionScript({
      env: { [COMPANION_SCRIPT_ENV]: path.join(root, "nowhere.mjs") },
      homeDir,
    });

    assert.equal(found, null);
  });

  test("prefers the highest cached plugin version, comparing numerically", () => {
    const homeDir = freshHome(root, "versions");
    touch(cachedScript(homeDir, "1.0.4"));
    touch(cachedScript(homeDir, "1.0.10"));
    touch(cachedScript(homeDir, "1.0.9"));
    touch(marketplaceScript(homeDir));

    assert.equal(findCompanionScript({ env: {}, homeDir }), cachedScript(homeDir, "1.0.10"));
  });

  test("skips a cached version without the script", () => {
    const homeDir = freshHome(root, "partial");
    fs.mkdirSync(path.dirname(cachedScript(homeDir, "2.0.0")), { recursive: true });
    touch(cachedScript(homeDir, "1.0.4"));

    assert.equal(findCompanionScript({ env: {}, homeDir }), cachedScript(homeDir, "1.0.4"));
  });

  test("falls back to the marketplace copy when nothing is cached", () => {
    const homeDir = freshHome(root, "marketplace");
    touch(marketplaceScript(homeDir));

    assert.equal(findCompanionScript({ env: {}, homeDir }), marketplaceScript(homeDir));
  });

  test("returns null when the plugin is not installed", () => {
    assert.equal(findCompanionScript({ env: {}, homeDir: freshHome(root, "empty") }), null);
  });
});

describe("companionEnvFor", () => {
  const pluginDataStateDir = path.join("home", ".claude", "plugins", "data", "codex-openai-codex", "state");
  const samePath = (left, right) => path.resolve(left) === path.resolve(right);

  test("points CLAUDE_PLUGIN_DATA at the plugin data dir for jobs stored there", () => {
    const env = companionEnvFor(pluginDataStateDir, { pluginDataStateDir, env: { PATH: "p" }, samePath });

    assert.deepEqual(env, { PATH: "p", CLAUDE_PLUGIN_DATA: path.dirname(pluginDataStateDir) });
  });

  test("drops an inherited CLAUDE_PLUGIN_DATA for jobs stored in the temp state root", () => {
    const env = companionEnvFor(path.join("tmp", "codex-companion"), {
      pluginDataStateDir,
      env: { PATH: "p", CLAUDE_PLUGIN_DATA: "elsewhere" },
      samePath,
    });

    assert.deepEqual(env, { PATH: "p" });
  });
});

describe("runCompanionCancel", () => {
  function fakeExecFile(outcome) {
    const calls = [];
    const execFileImpl = (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? "");
    };
    return { calls, execFileImpl };
  }

  test("runs `node <script> cancel <id> --cwd <workspaceRoot> --json` with a timeout", async () => {
    const { calls, execFileImpl } = fakeExecFile({ stdout: '{"status":"cancelled"}' });

    const outcome = await runCompanionCancel({
      script: "companion.mjs",
      jobId: "task-1",
      workspaceRoot: "/repo",
      env: { A: "1" },
      execFileImpl,
    });

    assert.deepEqual(outcome, { ok: true, result: { status: "cancelled" } });
    assert.equal(calls[0].file, process.execPath);
    assert.deepEqual(calls[0].args, cancelArguments("companion.mjs", "task-1", "/repo"));
    assert.deepEqual(calls[0].args.slice(1), ["cancel", "task-1", "--cwd", "/repo", "--json"]);
    assert.equal(calls[0].options.timeout, CANCEL_TIMEOUT_MS);
    assert.deepEqual(calls[0].options.env, { A: "1" });
  });

  test("reports the plugin's stderr when the cancel fails", async () => {
    const { execFileImpl } = fakeExecFile({ error: new Error("exit 1"), stderr: "No active job found.\n" });

    const outcome = await runCompanionCancel({ script: "s", jobId: "j", workspaceRoot: "/r", execFileImpl });

    assert.deepEqual(outcome, { ok: false, error: "No active job found." });
  });

  test("tolerates output that is not JSON", async () => {
    const { execFileImpl } = fakeExecFile({ stdout: "Cancelled task-1." });

    const outcome = await runCompanionCancel({ script: "s", jobId: "j", workspaceRoot: "/r", execFileImpl });

    assert.deepEqual(outcome, { ok: true, result: null });
  });
});
