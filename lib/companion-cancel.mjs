import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const COMPANION_SCRIPT_ENV = "CODEX_COMPANION_SCRIPT";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const SCRIPT_RELATIVE_PATH = path.join("scripts", "codex-companion.mjs");
// The plugin's own app-server requests time out after 90 s, so this only catches a hung CLI.
export const CANCEL_TIMEOUT_MS = 120_000;

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listDirectoryNames(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function newestFirst(versions) {
  return [...versions].sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
}

function cachedScriptCandidates(pluginsDir, listDirs) {
  const versionsDir = path.join(pluginsDir, "cache", "openai-codex", "codex");
  return newestFirst(listDirs(versionsDir)).map((version) =>
    path.join(versionsDir, version, SCRIPT_RELATIVE_PATH),
  );
}

function marketplaceScript(pluginsDir) {
  return path.join(pluginsDir, "marketplaces", "openai-codex", "plugins", "codex", SCRIPT_RELATIVE_PATH);
}

export function findCompanionScript({
  env = process.env,
  homeDir = os.homedir(),
  fileExists = isFile,
  listDirs = listDirectoryNames,
} = {}) {
  const override = env[COMPANION_SCRIPT_ENV];
  if (override) {
    // An explicit override never falls back to the installed plugin.
    return fileExists(override) ? override : null;
  }

  const pluginsDir = path.join(homeDir, ".claude", "plugins");
  const candidates = [...cachedScriptCandidates(pluginsDir, listDirs), marketplaceScript(pluginsDir)];
  return candidates.find(fileExists) ?? null;
}

function withoutPluginDataDir(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== PLUGIN_DATA_ENV));
}

export function companionEnvFor(stateRootDir, { pluginDataStateDir, env = process.env, samePath }) {
  const baseEnv = withoutPluginDataDir(env);
  if (!samePath(stateRootDir, pluginDataStateDir)) {
    return baseEnv;
  }
  return { ...baseEnv, [PLUGIN_DATA_ENV]: path.dirname(pluginDataStateDir) };
}

export function cancelArguments(script, jobId, workspaceRoot) {
  return [script, "cancel", jobId, "--cwd", workspaceRoot, "--json"];
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function failureDetail(error, stderr) {
  return (typeof stderr === "string" && stderr.trim()) || error.message;
}

export function runCompanionCancel({
  script,
  jobId,
  workspaceRoot,
  env,
  timeoutMs = CANCEL_TIMEOUT_MS,
  execFileImpl = execFile,
}) {
  return new Promise((resolve) => {
    execFileImpl(
      process.execPath,
      cancelArguments(script, jobId, workspaceRoot),
      { encoding: "utf8", env, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: failureDetail(error, stderr) });
          return;
        }
        resolve({ ok: true, result: parseJsonOutput(stdout) });
      },
    );
  });
}
