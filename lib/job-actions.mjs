import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { companionEnvFor, findCompanionScript, runCompanionCancel } from "./companion-cancel.mjs";
import { collectJobRecords, isActiveJob, isJobRecord, readStateFile } from "./job-records.mjs";
import {
  HttpError,
  findJob,
  isNonEmptyString,
  mutateTargetState,
  readTargetState,
  requireJobTarget,
  samePath,
} from "./job-target.mjs";
import { createLivenessProbe, killIfJobProcess } from "./process-identity.mjs";
import { pluginDataStateDir } from "./state-dirs.mjs";
import { StateLockBusyError, withStateLock, writeStateAtomic } from "./state-store.mjs";

const DASHBOARD_CANCEL_MESSAGE = "Cancelled via dashboard.";

async function probeActiveJob(livenessProbe, job) {
  return isActiveJob(job) ? livenessProbe.probe(job) : null;
}

function isStaleLiveness(job, alive) {
  return isActiveJob(job) && alive === false;
}

function jobView(record, alive) {
  return {
    ...record.sourceJob,
    repo: record.repo,
    dirName: record.dirName,
    baseDir: record.baseDir,
    alive,
    stale: isStaleLiveness(record.sourceJob, alive),
  };
}

async function withLiveness(context, record) {
  const alive = await probeActiveJob(context.livenessProbe, record.sourceJob);
  return { ...record, view: jobView(record, alive) };
}

async function scanAllJobRecords(context) {
  return Promise.all(collectJobRecords(context.baseDirs).map((record) => withLiveness(context, record)));
}

function bestEffortKill(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // The process may already be gone; cancellation still updates the job state.
  }
}

function bestEffortAppendCancellationLog(job, timestamp) {
  try {
    if (typeof job.logFile === "string" && fs.existsSync(job.logFile)) {
      fs.appendFileSync(
        job.logFile,
        `[${timestamp}] Cancelled via dashboard GUI.\n`,
        "utf8",
      );
    }
  } catch {
    // Logging must not make an otherwise successful cancellation fail.
  }
}

function cancelledJob(job, timestamp) {
  return {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: DASHBOARD_CANCEL_MESSAGE,
    completedAt: timestamp,
    cancelledAt: timestamp,
    updatedAt: timestamp,
  };
}

function jobFilePath(repoDir, jobId) {
  return path.join(repoDir, "jobs", `${jobId}.json`);
}

function readJobFile(filePath) {
  try {
    const job = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return isJobRecord(job) ? job : null;
  } catch {
    return null;
  }
}

// Mirrors the plugin's cancel: /codex:status and /codex:result read jobs/<id>.json, not state.json.
async function bestEffortMergeIntoJobFile(repoDir, job) {
  const filePath = jobFilePath(repoDir, job.id);
  const existing = readJobFile(filePath);
  if (!existing) {
    return;
  }
  try {
    await writeStateAtomic(filePath, { ...existing, ...job });
  } catch {
    // state.json already records the cancellation; the sidecar must not fail the request.
  }
}

function requireActiveJob(state, jobId) {
  const job = findJob(state, jobId);
  if (!job) {
    throw new HttpError(404, "Job not found.");
  }
  if (!isActiveJob(job)) {
    throw new HttpError(400, "Only running or queued jobs can be cancelled.");
  }
  return job;
}

function cancelActiveJob(state, jobId) {
  const original = requireActiveJob(state, jobId);
  const cancelled = cancelledJob(original, new Date().toISOString());
  state.jobs = state.jobs.map((job) => (job === original ? cancelled : job));
  return cancelled;
}

// Kill first, outside the lock, as the plugin does: a live worker could otherwise overwrite the cancellation.
async function stopActiveWorker(context, target) {
  const job = requireActiveJob(readTargetState(target), target.jobId);
  await killIfJobProcess(job, { probe: context.livenessProbe, kill: context.kill });
}

async function cancelInDashboard(context, target) {
  await stopActiveWorker(context, target);
  const cancelled = await mutateTargetState(target, (state) => cancelActiveJob(state, target.jobId));
  await bestEffortMergeIntoJobFile(target.repoDir, cancelled);
  bestEffortAppendCancellationLog(cancelled, cancelled.completedAt);
  return cancelled;
}

function hasCancelArguments(job) {
  return (
    isNonEmptyString(job.workspaceRoot) &&
    path.isAbsolute(job.workspaceRoot) &&
    !job.id.startsWith("-")
  );
}

// Only a verified live worker goes to the plugin: its cancel kills job.pid without checking whose it is.
async function shouldDelegateCancel(context, job) {
  return hasCancelArguments(job) && (await context.livenessProbe.probeFresh(job)) === true;
}

async function cancelViaCompanion(context, target, job) {
  const script = findCompanionScript();
  if (!script || !(await shouldDelegateCancel(context, job))) {
    return { handled: false, plugin: null };
  }

  const plugin = await runCompanionCancel({
    script,
    jobId: job.id,
    workspaceRoot: job.workspaceRoot,
    env: companionEnvFor(target.baseDir, { pluginDataStateDir: context.pluginDataStateDir, samePath }),
  });
  // The state file decides, not the exit code: the plugin may have resolved another state directory.
  const current = findJob(readTargetState(target), target.jobId);
  return { handled: current?.status === "cancelled", plugin, job: current };
}

async function cancelOneJob(context, body) {
  const target = requireJobTarget(body, context.baseDirs);
  const job = requireActiveJob(readTargetState(target), target.jobId);

  const delegated = await cancelViaCompanion(context, target, job);
  if (delegated.handled) {
    return { job: delegated.job, cancelledVia: "plugin", plugin: delegated.plugin };
  }

  const cancelled = await cancelInDashboard(context, target);
  return { job: cancelled, cancelledVia: "dashboard", plugin: delegated.plugin };
}

function groupStaleJobsByStateFile(records) {
  const groups = new Map();
  for (const record of records.filter((candidate) => candidate.view.stale)) {
    const group = groups.get(record.statePath) ?? {
      statePath: record.statePath,
      dirName: record.dirName,
      repo: record.repo,
      stalePids: new Map(),
    };
    group.stalePids.set(record.sourceJob.id, record.sourceJob.pid);
    groups.set(record.statePath, group);
  }
  return [...groups.values()];
}

// The scan already proved these PIDs dead or foreign; re-inspecting here would run a subprocess under the lock.
function isStillStale(job, stalePids) {
  return (
    isJobRecord(job) &&
    isActiveJob(job) &&
    stalePids.has(job.id) &&
    stalePids.get(job.id) === job.pid
  );
}

async function cancelJobsStillStale(statePath, stalePids) {
  const state = readStateFile(statePath);
  if (!state) {
    return [];
  }

  const jobs = state.jobs.filter((job) => isStillStale(job, stalePids));
  if (jobs.length === 0) {
    return [];
  }

  const timestamp = new Date().toISOString();
  const replacements = new Map(jobs.map((job) => [job, cancelledJob(job, timestamp)]));
  const nextState = { ...state, jobs: state.jobs.map((job) => replacements.get(job) ?? job) };
  await writeStateAtomic(statePath, nextState);
  return [...replacements.values()];
}

async function purgeStateFile(group) {
  try {
    return await withStateLock(path.dirname(group.statePath), () =>
      cancelJobsStillStale(group.statePath, group.stalePids),
    );
  } catch (error) {
    if (error instanceof StateLockBusyError) {
      return null;
    }
    throw error;
  }
}

async function purgeStaleJobs(context) {
  const purged = [];
  const skipped = [];

  for (const group of groupStaleJobsByStateFile(await scanAllJobRecords(context))) {
    const jobs = await purgeStateFile(group);
    if (jobs === null) {
      skipped.push({ dirName: group.dirName, repo: group.repo, reason: "state file locked" });
      continue;
    }

    for (const job of jobs) {
      // A stale PID is dead or belongs to an unrelated process, so purging never kills anything.
      await bestEffortMergeIntoJobFile(path.dirname(group.statePath), job);
      bestEffortAppendCancellationLog(job, job.completedAt);
      purged.push({ dirName: group.dirName, jobId: job.id, repo: group.repo });
    }
  }

  return { purged, skipped };
}

function bestEffortDeleteFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Missing or inaccessible job sidecar files do not fail the delete request.
  }
}

function removeFinishedJob(state, jobId) {
  const jobIndex = state.jobs.findIndex(
    (job) => job && typeof job === "object" && job.id === jobId,
  );

  if (jobIndex === -1) {
    throw new HttpError(404, "Job not found.");
  }

  const job = state.jobs[jobIndex];
  if (isActiveJob(job)) {
    throw new HttpError(400, "This job is running or queued; cancel it first.");
  }

  state.jobs.splice(jobIndex, 1);
}

async function deleteOneJob(context, body) {
  const target = requireJobTarget(body, context.baseDirs);
  await mutateTargetState(target, (state) => removeFinishedJob(state, target.jobId));

  const jobsDir = path.join(target.baseDir, target.dirName, "jobs");
  bestEffortDeleteFile(path.join(jobsDir, `${target.jobId}.log`));
  bestEffortDeleteFile(path.join(jobsDir, `${target.jobId}.json`));

  return target.jobId;
}

export function createJobActions({
  baseDirs,
  livenessProbe = createLivenessProbe(),
  kill = bestEffortKill,
  pluginDataStateDir: dataStateDir = pluginDataStateDir(),
}) {
  const context = { baseDirs, livenessProbe, kill, pluginDataStateDir: dataStateDir };
  return {
    listJobs: async () => (await scanAllJobRecords(context)).map((record) => record.view),
    cancelJob: (body) => cancelOneJob(context, body),
    purgeStaleJobs: () => purgeStaleJobs(context),
    deleteJob: (body) => deleteOneJob(context, body),
  };
}
