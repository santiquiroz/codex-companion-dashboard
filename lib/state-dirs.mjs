import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const STATE_DIR_ENV = "CODEX_COMPANION_STATE_DIR";
const DEFAULT_PLUGIN_ID = "codex-openai-codex";
const REPO_STATE_DIR_PATTERN = /-[0-9a-f]{16}$/;

function pluginDataRoot(homeDir) {
  return path.join(homeDir, ".claude", "plugins", "data");
}

function stateDirOfPlugin(homeDir, pluginId) {
  return path.join(pluginDataRoot(homeDir), pluginId, "state");
}

export function pluginDataStateDir(homeDir = os.homedir()) {
  return stateDirOfPlugin(homeDir, DEFAULT_PLUGIN_ID);
}

export function tempStateDir(tempDir = os.tmpdir()) {
  return path.join(tempDir, "codex-companion");
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

function holdsRepoState(stateDir, dirName) {
  return REPO_STATE_DIR_PATTERN.test(dirName) && fs.existsSync(path.join(stateDir, dirName, "state.json"));
}

function holdsCompanionState(stateDir) {
  return listDirectoryNames(stateDir).some((dirName) => holdsRepoState(stateDir, dirName));
}

function otherPluginStateDirs(homeDir) {
  return listDirectoryNames(pluginDataRoot(homeDir))
    .filter((pluginId) => pluginId !== DEFAULT_PLUGIN_ID)
    .sort()
    .map((pluginId) => stateDirOfPlugin(homeDir, pluginId))
    .filter(holdsCompanionState);
}

export function defaultStateDirs({ homeDir = os.homedir(), tempDir = os.tmpdir() } = {}) {
  return [pluginDataStateDir(homeDir), ...otherPluginStateDirs(homeDir), tempStateDir(tempDir)];
}

function overrideStateDirs(value = "") {
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveStateDirs({ env = process.env, homeDir = os.homedir(), tempDir = os.tmpdir() } = {}) {
  const overrides = overrideStateDirs(env[STATE_DIR_ENV]);
  return overrides.length > 0 ? overrides : defaultStateDirs({ homeDir, tempDir });
}
