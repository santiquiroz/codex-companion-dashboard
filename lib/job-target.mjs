import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { withStateLock, writeStateAtomic } from "./state-store.mjs";

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function isSafePathSegment(value) {
  return (
    isNonEmptyString(value) &&
    value !== "." &&
    value !== ".." &&
    path.basename(value) === value
  );
}

export function requireJobTarget(body, baseDirs) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !isNonEmptyString(body.baseDir) ||
    !isNonEmptyString(body.dirName) ||
    !isNonEmptyString(body.jobId)
  ) {
    throw new HttpError(400, "baseDir, dirName, and jobId are required.");
  }

  const baseDir = baseDirs.find((candidate) => samePath(candidate, body.baseDir));
  if (!baseDir) {
    throw new HttpError(400, "baseDir is not a recognized Codex Companion state directory.");
  }
  if (!isSafePathSegment(body.dirName)) {
    throw new HttpError(400, "dirName must be a direct state-directory name.");
  }
  if (!isSafePathSegment(body.jobId)) {
    throw new HttpError(400, "jobId must be a simple job identifier.");
  }

  const repoDir = path.resolve(baseDir, body.dirName);
  if (!samePath(path.dirname(repoDir), baseDir)) {
    throw new HttpError(400, "dirName must resolve directly beneath baseDir.");
  }

  return {
    baseDir,
    dirName: body.dirName,
    jobId: body.jobId,
    repoDir,
    statePath: path.join(repoDir, "state.json"),
  };
}

export function readTargetState(target) {
  let text;
  try {
    text = fs.readFileSync(target.statePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new HttpError(404, "Job not found.");
    }
    throw error;
  }

  const state = JSON.parse(text);
  if (!state || typeof state !== "object" || !Array.isArray(state.jobs)) {
    throw new HttpError(404, "Job not found.");
  }
  return state;
}

export function findJob(state, jobId) {
  return state.jobs.find((job) => job && typeof job === "object" && job.id === jobId);
}

export async function mutateTargetState(target, mutate) {
  if (!fs.existsSync(target.statePath)) {
    throw new HttpError(404, "Job not found.");
  }

  return withStateLock(target.repoDir, async () => {
    const state = readTargetState(target);
    const result = mutate(state);
    await writeStateAtomic(target.statePath, state);
    return result;
  });
}
