import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeSetupState } from "../../shared/contracts";
import {
  buildClaudeStatusLineCommand,
  installClaudeStatusLine,
  parseClaudeSettingsJsonc,
  type InstallClaudeStatusLineResult,
} from "./claude-installer";

const HOOK_FILES = [
  path.join("scripts", "statusline.js"),
  path.join("src", "shared", "claude-cache.js"),
] as const;

export type ClaudeHookPaths = {
  settingsPath: string;
  sourceBase: string;
  sourceRoot: string;
  destinationBase: string;
  destinationRoot: string;
};

export type ClaudeHookDeploymentOperations = {
  readFile: typeof fs.promises.readFile;
  writeFile: typeof fs.promises.writeFile;
  mkdir: typeof fs.promises.mkdir;
  lstat: typeof fs.promises.lstat;
  rename: typeof fs.promises.rename;
  rm: typeof fs.promises.rm;
};

const defaultOperations: ClaudeHookDeploymentOperations = {
  readFile: fs.promises.readFile.bind(fs.promises),
  writeFile: fs.promises.writeFile.bind(fs.promises),
  mkdir: fs.promises.mkdir.bind(fs.promises),
  lstat: fs.promises.lstat.bind(fs.promises),
  rename: fs.promises.rename.bind(fs.promises),
  rm: fs.promises.rm.bind(fs.promises),
};

export function resolveDeployedStatusLinePath(destinationRoot: string): string {
  return path.join(destinationRoot, "scripts", "statusline.js");
}

export async function inspectClaudeSetup(options: {
  settingsPath: string;
  deployedStatusLinePath: string;
  cacheAvailable: boolean;
  readFile?: typeof fs.promises.readFile;
}): Promise<ClaudeSetupState> {
  let contents: string;
  try {
    contents = await (options.readFile ?? fs.promises.readFile)(
      options.settingsPath,
      "utf8",
    );
  } catch {
    return {
      status: "error",
      message:
        "Claude settings could not be read. Open Claude Code once, then retry.",
    };
  }

  let parsed: unknown;
  try {
    parsed = parseClaudeSettingsJsonc(contents);
  } catch {
    return {
      status: "error",
      message:
        "Claude settings are invalid. Fix settings.json before installing.",
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: "error",
      message: "Claude settings must contain a JSON object.",
    };
  }
  if (!Object.hasOwn(parsed, "statusLine")) {
    return { status: "missing" };
  }

  let expectedCommand: string;
  try {
    expectedCommand = buildClaudeStatusLineCommand(
      options.deployedStatusLinePath,
    );
  } catch {
    return {
      status: "error",
      message: "The AI Usage Monitor hook location is invalid.",
    };
  }

  const statusLine = parsed.statusLine;
  if (
    isRecord(statusLine) &&
    Object.keys(statusLine).length === 2 &&
    statusLine.type === "command" &&
    statusLine.command === expectedCommand
  ) {
    return options.cacheAvailable
      ? { status: "available" }
      : { status: "installed-pending" };
  }
  return { status: "conflict" };
}

export async function deployClaudeHook(options: {
  trustedSourceBase: string;
  sourceRoot: string;
  trustedDestinationBase: string;
  destinationRoot: string;
  operations?: ClaudeHookDeploymentOperations;
}): Promise<{ status: "deployed"; statusLinePath: string } | {
  status: "error";
  message: string;
}> {
  const operations = options.operations ?? defaultOperations;
  const destinationStatusLine = resolveDeployedStatusLinePath(
    options.destinationRoot,
  );
  if (
    !(await hasSafeExistingPathComponents(
      options.trustedSourceBase,
      options.sourceRoot,
      operations,
    )) ||
    !(await hasSafeExistingPathComponents(
      options.trustedDestinationBase,
      options.destinationRoot,
      operations,
    ))
  ) {
    return {
      status: "error",
      message:
        "The Claude hook path contains a symlink or unsafe app directory.",
    };
  }
  const source = await readVerifiedLayout(
    options.sourceRoot,
    operations,
  ).catch(() => null);
  if (!source) {
    return {
      status: "error",
      message: "The packaged Claude hook is missing or unsafe.",
    };
  }

  const destinationCondition = await inspectDestination(
    options.destinationRoot,
    source,
    operations,
  );
  if (destinationCondition === "unsafe") {
    return {
      status: "error",
      message:
        "The Claude hook directory is symlinked or unsafe. Remove it, then retry.",
    };
  }
  if (destinationCondition === "current") {
    return { status: "deployed", statusLinePath: destinationStatusLine };
  }

  const parent = path.dirname(options.destinationRoot);
  const staging = path.join(
    parent,
    `.${path.basename(options.destinationRoot)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const displaced = path.join(
    parent,
    `.${path.basename(options.destinationRoot)}.${process.pid}.${randomUUID()}.old`,
  );
  let destinationDisplaced = false;
  let replacementInstalled = false;
  try {
    await operations.mkdir(parent, { recursive: true });
    if (!(await isSafeDirectory(parent, operations))) {
      throw new TypeError("Hook destination parent is unsafe.");
    }
    for (const [relativePath, contents] of source) {
      const destination = path.join(staging, relativePath);
      await operations.mkdir(path.dirname(destination), { recursive: true });
      await operations.writeFile(destination, contents, { flag: "wx" });
    }
    if (
      (await inspectDestination(staging, source, operations)) !== "current"
    ) {
      throw new TypeError("Staged hook deployment failed verification.");
    }
    if (destinationCondition === "replace") {
      await operations.rename(options.destinationRoot, displaced);
      destinationDisplaced = true;
    }
    await operations.rename(staging, options.destinationRoot);
    replacementInstalled = true;
    if (
      (await inspectDestination(
        options.destinationRoot,
        source,
        operations,
      )) !== "current"
    ) {
      throw new TypeError("Installed hook deployment failed verification.");
    }
    if (destinationDisplaced) {
      await operations.rm(displaced, { recursive: true, force: true });
      destinationDisplaced = false;
    }
    return { status: "deployed", statusLinePath: destinationStatusLine };
  } catch {
    if (replacementInstalled) {
      await operations
        .rm(options.destinationRoot, { recursive: true, force: true })
        .catch(() => undefined);
    }
    if (destinationDisplaced) {
      await operations
        .rename(displaced, options.destinationRoot)
        .catch(() => undefined);
    }
    await operations.rm(staging, { recursive: true, force: true }).catch(
      () => undefined,
    );
    const recovered = await inspectDestination(
      options.destinationRoot,
      source,
      operations,
    );
    if (recovered === "current") {
      await operations
        .rm(displaced, { recursive: true, force: true })
        .catch(() => undefined);
      return { status: "deployed", statusLinePath: destinationStatusLine };
    }
    return {
      status: "error",
      message:
        "The Claude hook could not be deployed. Check Local AppData access and retry.",
    };
  }
}

export async function installClaudeHook(options: {
  paths: ClaudeHookPaths;
  deploy?: typeof deployClaudeHook;
  install?: typeof installClaudeStatusLine;
}): Promise<ClaudeSetupState> {
  const deployment = await (options.deploy ?? deployClaudeHook)({
    trustedSourceBase: options.paths.sourceBase,
    sourceRoot: options.paths.sourceRoot,
    trustedDestinationBase: options.paths.destinationBase,
    destinationRoot: options.paths.destinationRoot,
  });
  if (deployment.status === "error") {
    return { status: "error", message: deployment.message };
  }

  const result = await (options.install ?? installClaudeStatusLine)({
    settingsPath: options.paths.settingsPath,
    compiledStatusLinePath: deployment.statusLinePath,
  });
  return mapInstallResult(result);
}

function mapInstallResult(
  result: InstallClaudeStatusLineResult,
): ClaudeSetupState {
  if (result.status === "installed") {
    return { status: "installed-pending" };
  }
  if (result.status === "statusline-conflict") {
    return { status: "conflict" };
  }
  return {
    status: "error",
    message:
      result.status === "backup-conflict"
        ? "A previous settings backup already exists. Move it aside, then retry."
        : result.message,
  };
}

type LayoutContents = ReadonlyArray<readonly [string, Buffer]>;

async function readVerifiedLayout(
  root: string,
  operations: ClaudeHookDeploymentOperations,
): Promise<LayoutContents> {
  if (!(await isSafeDirectory(root, operations))) {
    throw new TypeError("Hook root is unsafe.");
  }
  const directories = new Set(
    HOOK_FILES.map((relativePath) => path.dirname(relativePath)),
  );
  for (const relativeDirectory of directories) {
    if (
      !(await isSafeDirectory(
        path.join(root, relativeDirectory),
        operations,
      ))
    ) {
      throw new TypeError("Hook layout directory is unsafe.");
    }
  }
  return Promise.all(
    HOOK_FILES.map(async (relativePath) => {
      const filePath = path.join(root, relativePath);
      const entry = await operations.lstat(filePath);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new TypeError("Hook layout file is unsafe.");
      }
      return [relativePath, await operations.readFile(filePath)] as const;
    }),
  );
}

async function inspectDestination(
  root: string,
  source: LayoutContents,
  operations: ClaudeHookDeploymentOperations,
): Promise<"absent" | "current" | "replace" | "unsafe"> {
  let rootEntry: fs.Stats;
  try {
    rootEntry = await operations.lstat(root);
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? "absent" : "unsafe";
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    return "unsafe";
  }
  try {
    const destination = await readVerifiedLayout(root, operations);
    return layoutsEqual(source, destination) ? "current" : "replace";
  } catch {
    return (await layoutContainsSymlink(root, operations))
      ? "unsafe"
      : "replace";
  }
}

async function layoutContainsSymlink(
  root: string,
  operations: ClaudeHookDeploymentOperations,
): Promise<boolean> {
  for (const relativePath of [
    ...new Set(HOOK_FILES.map((entry) => path.dirname(entry))),
    ...HOOK_FILES,
  ]) {
    try {
      const entry = await operations.lstat(path.join(root, relativePath));
      if (entry.isSymbolicLink()) {
        return true;
      }
    } catch {
      // Missing regular layout entries are repairable.
    }
  }
  return false;
}

async function isSafeDirectory(
  directory: string,
  operations: ClaudeHookDeploymentOperations,
): Promise<boolean> {
  try {
    const entry = await operations.lstat(directory);
    return entry.isDirectory() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSafeExistingPathComponents(
  trustedBase: string,
  target: string,
  operations: ClaudeHookDeploymentOperations,
): Promise<boolean> {
  const base = path.resolve(trustedBase);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(base, resolvedTarget);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return false;
  }

  let current = base;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const entry = await operations.lstat(current);
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (current !== resolvedTarget && !entry.isDirectory()) {
        return false;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return true;
      }
      return false;
    }
  }
  return true;
}

function layoutsEqual(
  expected: LayoutContents,
  actual: LayoutContents,
): boolean {
  return expected.every(([relativePath, contents], index) => {
    const candidate = actual[index];
    return (
      candidate?.[0] === relativePath &&
      contents.equals(candidate[1])
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
