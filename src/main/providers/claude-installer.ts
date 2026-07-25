import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type InstallClaudeStatusLineResult =
  | { status: "installed"; backupPath: string }
  | {
      status:
        | "invalid-settings"
        | "invalid-root"
        | "statusline-conflict"
        | "invalid-deployment"
        | "backup-conflict"
        | "write-failed";
      message: string;
    };

export type InstallerFileOperations = {
  readFile: typeof fs.promises.readFile;
  writeFile: typeof fs.promises.writeFile;
  rename: typeof fs.promises.rename;
  rm: typeof fs.promises.rm;
  stat: typeof fs.promises.stat;
};

const defaultOperations: InstallerFileOperations = {
  readFile: fs.promises.readFile.bind(fs.promises),
  writeFile: fs.promises.writeFile.bind(fs.promises),
  rename: fs.promises.rename.bind(fs.promises),
  rm: fs.promises.rm.bind(fs.promises),
  stat: fs.promises.stat.bind(fs.promises),
};

export function buildClaudeStatusLineCommand(
  compiledStatusLinePath: string,
): string {
  if (
    !path.isAbsolute(compiledStatusLinePath) ||
    hasAsarPathSegment(compiledStatusLinePath) ||
    compiledStatusLinePath.includes('"') ||
    compiledStatusLinePath.includes("$") ||
    compiledStatusLinePath.includes("`") ||
    /[\r\n]/u.test(compiledStatusLinePath)
  ) {
    throw new TypeError(
      "Statusline path must be an absolute safe filesystem path.",
    );
  }
  return `node "${compiledStatusLinePath}"`;
}

export async function installClaudeStatusLine(options: {
  settingsPath: string;
  compiledStatusLinePath: string;
  operations?: InstallerFileOperations;
}): Promise<InstallClaudeStatusLineResult> {
  const operations = options.operations ?? defaultOperations;
  let original: Buffer;
  let sourceMode: number;
  try {
    const [contents, sourceStat] = await Promise.all([
      operations.readFile(options.settingsPath),
      operations.stat(options.settingsPath),
    ]);
    if (!sourceStat.isFile()) {
      throw new TypeError("Claude settings are not a regular file.");
    }
    original = contents;
    sourceMode = sourceStat.mode & 0o777;
  } catch {
    return {
      status: "invalid-settings",
      message: "Claude settings could not be read.",
    };
  }

  const originalText = original.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizeJsonc(originalText));
  } catch {
    return {
      status: "invalid-settings",
      message: "Claude settings are not valid JSON or JSONC.",
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: "invalid-root",
      message: "Claude settings root must be an object.",
    };
  }
  if (Object.hasOwn(parsed, "statusLine")) {
    return {
      status: "statusline-conflict",
      message: "Claude settings already define statusLine.",
    };
  }

  let command: string;
  let updated: string;
  try {
    command = buildClaudeStatusLineCommand(options.compiledStatusLinePath);
    updated = insertTopLevelStatusLine(originalText, command);
  } catch {
    return {
      status: "invalid-deployment",
      message: "Compiled Claude statusline deployment is invalid.",
    };
  }

  if (
    !(await isCompleteStatusLineDeployment(
      options.compiledStatusLinePath,
      operations,
    ))
  ) {
    return {
      status: "invalid-deployment",
      message: "Compiled Claude statusline deployment is incomplete.",
    };
  }

  const backupPath = `${options.settingsPath}.ai-usage-monitor.bak`;
  try {
    await operations.stat(backupPath);
    return {
      status: "backup-conflict",
      message: "Claude settings backup already exists.",
    };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      return {
        status: "write-failed",
        message: "Claude settings backup could not be checked.",
      };
    }
  }

  const temporaryPath = path.join(
    path.dirname(options.settingsPath),
    `.${path.basename(options.settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await operations.writeFile(backupPath, original, {
      flag: "wx",
      mode: sourceMode,
    });
    await operations.writeFile(temporaryPath, updated, {
      encoding: "utf8",
      flag: "wx",
      mode: sourceMode,
    });
    await operations.rename(temporaryPath, options.settingsPath);
    return { status: "installed", backupPath };
  } catch {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
    return {
      status: "write-failed",
      message:
        "Claude settings were not changed; installation could not complete.",
    };
  }
}

export function insertTopLevelStatusLine(
  original: string,
  command: string,
): string {
  const rootClose = findRootClosingBrace(original);
  const normalized = normalizeJsonc(original);
  let lastContent = rootClose - 1;
  while (lastContent >= 0 && /\s/u.test(normalized[lastContent] ?? "")) {
    lastContent -= 1;
  }
  if (lastContent < 0) {
    throw new TypeError("Settings root is unavailable.");
  }

  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const indent = detectTopLevelIndent(original) ?? "  ";
  const property = `${indent}"statusLine": ${JSON.stringify({
    type: "command",
    command,
  })}`;
  const lastCharacter = original[lastContent];

  if (lastCharacter === "{") {
    const insertion = `${newline}${property}${newline}`;
    return (
      original.slice(0, lastContent + 1) +
      insertion +
      original.slice(lastContent + 1)
    );
  }

  const separator = lastCharacter === "," ? newline : `,${newline}`;
  return (
    original.slice(0, lastContent + 1) +
    separator +
    property +
    original.slice(lastContent + 1)
  );
}

function normalizeJsonc(input: string): string {
  const characters = input.split("");
  let inString = false;
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index] ?? "";
    const next = characters[index + 1] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current === "/" && next === "/") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (
        index < characters.length &&
        characters[index] !== "\n" &&
        characters[index] !== "\r"
      ) {
        characters[index] = " ";
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (current === "/" && next === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      let closed = false;
      while (index < characters.length) {
        if (
          characters[index] === "*" &&
          characters[index + 1] === "/"
        ) {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 1;
          closed = true;
          break;
        }
        if (characters[index] !== "\n" && characters[index] !== "\r") {
          characters[index] = " ";
        }
        index += 1;
      }
      if (!closed) {
        throw new SyntaxError("Unterminated JSONC comment.");
      }
    }
  }

  return removeTrailingCommas(characters.join(""));
}

function removeTrailingCommas(input: string): string {
  const characters = input.split("");
  let inString = false;
  let escaped = false;

  for (let index = 0; index < characters.length; index += 1) {
    const current = characters[index] ?? "";
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current !== ",") {
      continue;
    }

    let lookahead = index + 1;
    while (
      lookahead < characters.length &&
      /\s/u.test(characters[lookahead] ?? "")
    ) {
      lookahead += 1;
    }
    if (
      characters[lookahead] === "}" ||
      characters[lookahead] === "]"
    ) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function findRootClosingBrace(input: string): number {
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let depth = 0;
  let rootStarted = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (lineComment) {
      if (current === "\n" || current === "\r") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (current === '"') {
      inString = true;
      continue;
    }
    if (current === "{") {
      depth += 1;
      rootStarted = true;
    } else if (current === "}") {
      depth -= 1;
      if (rootStarted && depth === 0) {
        return index;
      }
    }
  }
  throw new SyntaxError("Settings root object is incomplete.");
}

function detectTopLevelIndent(input: string): string | null {
  const match = input.match(/(?:\r?\n)([ \t]+)"/u);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function hasAsarPathSegment(filePath: string): boolean {
  return filePath
    .split(/[\\/]/u)
    .some((segment) => segment.toLowerCase().endsWith(".asar"));
}

async function isCompleteStatusLineDeployment(
  compiledStatusLinePath: string,
  operations: InstallerFileOperations,
): Promise<boolean> {
  const dependencyPath = path.resolve(
    path.dirname(compiledStatusLinePath),
    "..",
    "src",
    "shared",
    "claude-cache.js",
  );
  try {
    const [entrypoint, dependency] = await Promise.all([
      operations.stat(compiledStatusLinePath),
      operations.stat(dependencyPath),
    ]);
    return entrypoint.isFile() && dependency.isFile();
  } catch {
    return false;
  }
}
