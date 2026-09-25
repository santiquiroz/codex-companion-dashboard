import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import {
  STATE_DIR_ENV,
  pluginDataStateDir,
  resolveStateDirs,
  tempStateDir,
} from "../lib/state-dirs.mjs";

const REPO_DIR_NAME = "some-repo-0123456789abcdef";

function writeStateJson(stateDir, dirName) {
  const repoDir = path.join(stateDir, dirName);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "state.json"), JSON.stringify({ jobs: [] }), "utf8");
}

function pluginStateDir(homeDir, pluginId) {
  return path.join(homeDir, ".claude", "plugins", "data", pluginId, "state");
}

describe("resolveStateDirs with the override variable", () => {
  const homeDir = path.join("h", "user");
  const tempDir = path.join("t", "tmp");

  test("uses only the listed directories, split by the platform path delimiter", () => {
    const first = path.join("x", "one");
    const second = path.join("y", "two");
    const env = { [STATE_DIR_ENV]: [first, "", ` ${second} `].join(path.delimiter) };

    assert.deepEqual(resolveStateDirs({ env, homeDir, tempDir }), [first, second]);
  });

  test("falls back to discovery when the variable is empty", () => {
    const env = { [STATE_DIR_ENV]: ` ${path.delimiter} ` };

    assert.deepEqual(resolveStateDirs({ env, homeDir, tempDir }), [
      pluginDataStateDir(homeDir),
      tempStateDir(tempDir),
    ]);
  });
});

describe("resolveStateDirs discovery without the override variable", () => {
  let root;
  let homeDir;
  let tempDir;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-state-dirs-"));
    homeDir = path.join(root, "home");
    tempDir = path.join(root, "temp");
    writeStateJson(pluginStateDir(homeDir, "codex-openai-codex"), REPO_DIR_NAME);
    writeStateJson(pluginStateDir(homeDir, "zz-other-id"), REPO_DIR_NAME);
    writeStateJson(pluginStateDir(homeDir, "aa-other-id"), REPO_DIR_NAME);
    writeStateJson(pluginStateDir(homeDir, "no-hash-suffix"), "some-repo");
    fs.mkdirSync(path.join(pluginStateDir(homeDir, "no-state-json"), REPO_DIR_NAME), { recursive: true });
    fs.mkdirSync(path.join(homeDir, ".claude", "plugins", "data", "no-state-dir"), { recursive: true });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("lists the default plugin dir first, then every other plugin id holding companion state, then temp", () => {
    assert.deepEqual(resolveStateDirs({ env: {}, homeDir, tempDir }), [
      pluginDataStateDir(homeDir),
      pluginStateDir(homeDir, "aa-other-id"),
      pluginStateDir(homeDir, "zz-other-id"),
      tempStateDir(tempDir),
    ]);
  });

  test("keeps the default plugin dir and temp dir when nothing has been written yet", () => {
    const emptyHome = path.join(root, "empty-home");

    assert.deepEqual(resolveStateDirs({ env: {}, homeDir: emptyHome, tempDir }), [
      pluginDataStateDir(emptyHome),
      tempStateDir(tempDir),
    ]);
  });
});
