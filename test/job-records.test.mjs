import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { collectJobRecords, repoNameFromDir, uniqueBy } from "../lib/job-records.mjs";
import { defaultStateDirs, pluginDataStateDir } from "../lib/state-dirs.mjs";

function writeState(baseDir, dirName, content) {
  const repoDir = path.join(baseDir, dirName);
  fs.mkdirSync(repoDir, { recursive: true });
  const text = typeof content === "string" ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(repoDir, "state.json"), text, "utf8");
}

describe("collectJobRecords reads job state from the injected base directories", () => {
  let root;
  let firstBase;
  let secondBase;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ccd-records-"));
    firstBase = path.join(root, "first");
    secondBase = path.join(root, "second");
    writeState(firstBase, "alpha-0123456789abcdef", {
      jobs: [{ id: "a1", status: "running" }, null, ["not", "a", "job"], { id: "a2", status: "completed" }],
    });
    writeState(firstBase, "broken-0123456789abcdef", "{ not json");
    writeState(firstBase, "nojobs-0123456789abcdef", { jobs: "nope" });
    fs.writeFileSync(path.join(firstBase, "stray-file.txt"), "ignored", "utf8");
    writeState(secondBase, "alpha-0123456789abcdef", { jobs: [{ id: "a1", status: "failed" }] });
    writeState(secondBase, "beta", { jobs: [{ id: "b1", status: "queued" }] });
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("returns one record per job with its repo, directory and state path", () => {
    const records = collectJobRecords([firstBase]);

    assert.deepEqual(
      records.map((record) => [record.repo, record.dirName, record.baseDir, record.sourceJob.id]),
      [
        ["alpha", "alpha-0123456789abcdef", firstBase, "a1"],
        ["alpha", "alpha-0123456789abcdef", firstBase, "a2"],
      ],
    );
    assert.equal(records[0].statePath, path.join(firstBase, "alpha-0123456789abcdef", "state.json"));
  });

  test("skips missing base directories, stray files, malformed state and non-object jobs", () => {
    const records = collectJobRecords([path.join(root, "missing"), firstBase]);

    assert.deepEqual(records.map((record) => record.sourceJob.id), ["a1", "a2"]);
  });

  test("keeps the first occurrence of a job directory and id across base directories", () => {
    const records = collectJobRecords([firstBase, secondBase]);

    assert.deepEqual(
      records.map((record) => [record.dirName, record.sourceJob.id, record.sourceJob.status]),
      [
        ["alpha-0123456789abcdef", "a1", "running"],
        ["alpha-0123456789abcdef", "a2", "completed"],
        ["beta", "b1", "queued"],
      ],
    );
  });

  test("never reads the user's real state directories", () => {
    assert.deepEqual(collectJobRecords([]), []);
  });
});

describe("state directory helpers", () => {
  test("repoNameFromDir strips only a trailing 16-hex-digit hash", () => {
    assert.equal(repoNameFromDir("my-repo-0123456789abcdef"), "my-repo");
    assert.equal(repoNameFromDir("my-repo-0123"), "my-repo-0123");
  });

  test("defaultStateDirs lists the plugin data state dir and the temp companion dir", () => {
    const homeDir = path.join("h", "user");
    const tempDir = path.join("t", "tmp");

    assert.equal(
      pluginDataStateDir(homeDir),
      path.join(homeDir, ".claude", "plugins", "data", "codex-openai-codex", "state"),
    );
    assert.deepEqual(defaultStateDirs({ homeDir, tempDir }), [
      pluginDataStateDir(homeDir),
      path.join(tempDir, "codex-companion"),
    ]);
  });

  test("uniqueBy keeps the first item for each key without mutating the input", () => {
    const items = [{ k: 1, v: "a" }, { k: 2, v: "b" }, { k: 1, v: "c" }];

    assert.deepEqual(uniqueBy(items, (item) => item.k), [{ k: 1, v: "a" }, { k: 2, v: "b" }]);
    assert.equal(items.length, 3);
  });
});
