import fs from "node:fs";
import path from "node:path";

export const ACTIVE_STATUSES = new Set(["running", "queued"]);
export const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isJobRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isActiveJob(job) {
  return ACTIVE_STATUSES.has(job.status);
}

export function readStateFile(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return isJobRecord(state) && Array.isArray(state.jobs) ? state : null;
  } catch {
    return null;
  }
}

export function repoNameFromDir(dirName) {
  return dirName.replace(/-[0-9a-f]{16}$/, "");
}

export function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function listStateDirNames(baseDir) {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function recordsInStateDir(baseDir, dirName) {
  const statePath = path.join(baseDir, dirName, "state.json");
  // Missing, unreadable, and malformed state files are intentionally skipped.
  const state = readStateFile(statePath);
  if (!state) {
    return [];
  }

  const repo = repoNameFromDir(dirName);
  return state.jobs
    .filter(isJobRecord)
    .map((sourceJob) => ({ sourceJob, statePath, repo, dirName, baseDir }));
}

function recordsInBaseDir(baseDir) {
  return listStateDirNames(baseDir).flatMap((dirName) => recordsInStateDir(baseDir, dirName));
}

export function collectJobRecords(baseDirs) {
  return uniqueBy(
    baseDirs.flatMap(recordsInBaseDir),
    (record) => `${record.dirName}:${record.sourceJob.id}`,
  );
}
