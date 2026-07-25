import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClaudeStatusLineCommand,
  installClaudeStatusLine,
  type InstallerFileOperations,
} from "./claude-installer";

async function createCompleteDeployment(
  statuslinePath: string,
): Promise<void> {
  const dependencyPath = path.resolve(
    path.dirname(statuslinePath),
    "..",
    "src",
    "shared",
    "claude-cache.js",
  );
  await Promise.all([
    fs.promises.mkdir(path.dirname(statuslinePath), { recursive: true }),
    fs.promises.mkdir(path.dirname(dependencyPath), { recursive: true }),
  ]);
  await Promise.all([
    fs.promises.writeFile(statuslinePath, "// test entrypoint\n"),
    fs.promises.writeFile(dependencyPath, "// test dependency\n"),
  ]);
}

test("adds only statusLine and preserves CRLF, indentation, and backup bytes", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-space -"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const statuslinePath = path.join(directory, "compiled tools", "statusline.js");
  const original =
    '{\r\n    "model": "opus",\r\n    "permissions": {\r\n        "allow": ["Read"]\r\n    }\r\n}\r\n';
  try {
    await fs.promises.writeFile(settingsPath, original);
    await fs.promises.chmod(settingsPath, 0o640);
    const sourceMode = (await fs.promises.stat(settingsPath)).mode & 0o777;
    await createCompleteDeployment(statuslinePath);
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath: statuslinePath,
    });
    assert.equal(result.status, "installed");
    if (result.status !== "installed") {
      return;
    }
    assert.deepEqual(await fs.promises.readFile(result.backupPath), Buffer.from(original));
    assert.equal(
      (await fs.promises.stat(result.backupPath)).mode & 0o777,
      sourceMode,
    );
    const updated = await fs.promises.readFile(settingsPath, "utf8");
    assert.equal(
      (await fs.promises.stat(settingsPath)).mode & 0o777,
      sourceMode,
    );
    assert.equal(updated.endsWith("\r\n"), true);
    assert.equal(updated.includes("\r\n    \"statusLine\""), true);
    const parsed = JSON.parse(updated) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      "model",
      "permissions",
      "statusLine",
    ]);
    assert.deepEqual(parsed.model, "opus");
    assert.deepEqual(parsed.permissions, { allow: ["Read"] });
    assert.deepEqual(parsed.statusLine, {
      type: "command",
      command: `node "${statuslinePath}"`,
    });
    assert.equal(
      updated.replace(/,\r\n    "statusLine": .*(?=\r\n\})/u, ""),
      original,
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("preserves JSONC comments and trailing comma around insertion", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-jsonc-"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const statuslinePath = path.join(
    directory,
    "deployment",
    "scripts",
    "statusline.js",
  );
  const original = '{\n  // keep this\n  "model": "sonnet",\n}\n';
  try {
    await fs.promises.writeFile(settingsPath, original);
    await createCompleteDeployment(statuslinePath);
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath: statuslinePath,
    });
    assert.equal(result.status, "installed");
    const updated = await fs.promises.readFile(settingsPath, "utf8");
    assert.equal(updated.includes("// keep this"), true);
    assert.equal(updated.includes('"model": "sonnet",'), true);
    assert.equal(updated.includes('"statusLine"'), true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("preserves trailing comments and comments in an empty root", async () => {
  for (const original of [
    '{\n  "model": "opus"\n  // trailing root comment\n}\n',
    "{\n  // empty root comment\n}\n",
  ]) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-installer-comments-"),
    );
    const settingsPath = path.join(directory, "settings.json");
    const statuslinePath = path.join(
      directory,
      "deployment",
      "scripts",
      "statusline.js",
    );
    try {
      await fs.promises.writeFile(settingsPath, original);
      await createCompleteDeployment(statuslinePath);
      const result = await installClaudeStatusLine({
        settingsPath,
        compiledStatusLinePath: statuslinePath,
      });
      assert.equal(result.status, "installed");
      const updated = await fs.promises.readFile(settingsPath, "utf8");
      assert.equal(updated.includes("//"), true);
      assert.equal(updated.includes('"statusLine"'), true);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test("does not treat comma-brace literals as JSONC trailing commas", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-literals-"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const statuslinePath = path.join(
    directory,
    "deployment",
    "scripts",
    "statusline.js",
  );
  const original =
    '{\n  "objectLiteral": ",}",\n  "arrayLiteral": ",]",\n  "nested": ["keep,]", "keep,}"],\n}\n';
  try {
    await fs.promises.writeFile(settingsPath, original);
    await createCompleteDeployment(statuslinePath);
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath: statuslinePath,
    });
    assert.equal(result.status, "installed");
    const updated = await fs.promises.readFile(settingsPath, "utf8");
    assert.equal(updated.includes('"objectLiteral": ",}"'), true);
    assert.equal(updated.includes('"arrayLiteral": ",]"'), true);
    assert.equal(updated.includes('"keep,]"'), true);
    assert.equal(updated.includes('"keep,}"'), true);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("refuses conflicts, invalid JSON, and non-object roots without writes", async () => {
  for (const [contents, expected] of [
    ['{"statusLine":{"type":"command","command":"custom"}}', "statusline-conflict"],
    ["{", "invalid-settings"],
    ["[]", "invalid-root"],
  ] as const) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-installer-refuse-"),
    );
    const settingsPath = path.join(directory, "settings.json");
    try {
      await fs.promises.writeFile(settingsPath, contents);
      const result = await installClaudeStatusLine({
        settingsPath,
        compiledStatusLinePath: path.join(directory, "statusline.js"),
      });
      assert.equal(result.status, expected);
      assert.equal(await fs.promises.readFile(settingsPath, "utf8"), contents);
      assert.deepEqual(await fs.promises.readdir(directory), ["settings.json"]);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});

test("atomic rename failure leaves settings intact and cleans temp", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-failure-"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const original = '{"model":"opus"}\n';
  const statuslinePath = path.join(
    directory,
    "deployment",
    "scripts",
    "statusline.js",
  );
  try {
    await fs.promises.writeFile(settingsPath, original);
    await createCompleteDeployment(statuslinePath);
    const operations: InstallerFileOperations = {
      readFile: fs.promises.readFile.bind(fs.promises),
      writeFile: fs.promises.writeFile.bind(fs.promises),
      rename: async () => {
        throw new Error("injected rename failure");
      },
      rm: fs.promises.rm.bind(fs.promises),
      stat: fs.promises.stat.bind(fs.promises),
    };
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath: statuslinePath,
      operations,
    });
    assert.equal(result.status, "write-failed");
    assert.equal(await fs.promises.readFile(settingsPath, "utf8"), original);
    assert.deepEqual(
      await fs.promises.readFile(
        `${settingsPath}.ai-usage-monitor.bak`,
        "utf8",
      ),
      original,
    );
    assert.equal(
      (await fs.promises.readdir(directory)).some((name) =>
        name.startsWith(".settings.json."),
      ),
      false,
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("existing backup deterministically blocks a settings write", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-backup-"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const original = '{"model":"opus"}\n';
  const statuslinePath = path.join(
    directory,
    "deployment",
    "scripts",
    "statusline.js",
  );
  try {
    await fs.promises.writeFile(settingsPath, original);
    await createCompleteDeployment(statuslinePath);
    await fs.promises.writeFile(
      `${settingsPath}.ai-usage-monitor.bak`,
      "older backup",
    );
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath: statuslinePath,
    });
    assert.equal(result.status, "backup-conflict");
    assert.equal(await fs.promises.readFile(settingsPath, "utf8"), original);
    assert.equal(
      await fs.promises.readFile(
        `${settingsPath}.ai-usage-monitor.bak`,
        "utf8",
      ),
      "older backup",
    );
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("builds a path-with-spaces command safe for Git Bash and PowerShell", () => {
  assert.equal(
    buildClaudeStatusLineCommand(
      "C:\\Program Files\\AI Usage Monitor\\statusline.js",
    ),
    'node "C:\\Program Files\\AI Usage Monitor\\statusline.js"',
  );
  assert.throws(() => buildClaudeStatusLineCommand("relative/statusline.js"));
  assert.throws(() =>
    buildClaudeStatusLineCommand(
      "C:\\Program Files\\AI Usage Monitor\\resources\\app.asar\\dist-tools\\scripts\\statusline.js",
    ),
  );
  assert.throws(() =>
    buildClaudeStatusLineCommand(
      "C:\\Program Files\\AI Usage Monitor\\resources\\APP.ASAR\\statusline.js",
    ),
  );
  assert.throws(() =>
    buildClaudeStatusLineCommand(
      "C:\\Users\\person\\$profile\\statusline.js",
    ),
  );
  assert.throws(() =>
    buildClaudeStatusLineCommand(
      "C:\\Users\\person\\`command\\statusline.js",
    ),
  );
});

test("installer rejects an ASAR-internal hook path before backup or write", async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-installer-asar-"),
  );
  const settingsPath = path.join(directory, "settings.json");
  const original = '{"model":"opus"}\n';
  try {
    await fs.promises.writeFile(settingsPath, original);
    const result = await installClaudeStatusLine({
      settingsPath,
      compiledStatusLinePath:
        "C:\\AI Usage Monitor\\resources\\app.asar\\dist-tools\\scripts\\statusline.js",
    });
    assert.equal(result.status, "invalid-deployment");
    assert.equal(await fs.promises.readFile(settingsPath, "utf8"), original);
    assert.deepEqual(await fs.promises.readdir(directory), ["settings.json"]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("installer rejects missing, incomplete, and interpolated deployments without writes", async () => {
  for (const kind of ["missing", "incomplete", "dollar", "backtick"] as const) {
    const directory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aum-installer-deployment-"),
    );
    const settingsPath = path.join(directory, "settings.json");
    const safeStatuslinePath = path.join(
      directory,
      "deployment",
      "scripts",
      "statusline.js",
    );
    const statuslinePath =
      kind === "dollar"
        ? path.join(directory, "$profile", "scripts", "statusline.js")
        : kind === "backtick"
          ? path.join(directory, "`command", "scripts", "statusline.js")
          : safeStatuslinePath;
    const original = '{"model":"opus"}\n';
    try {
      await fs.promises.writeFile(settingsPath, original);
      if (kind === "incomplete") {
        await fs.promises.mkdir(path.dirname(statuslinePath), {
          recursive: true,
        });
        await fs.promises.writeFile(statuslinePath, "// no dependency\n");
      } else if (kind === "dollar" || kind === "backtick") {
        await createCompleteDeployment(statuslinePath);
      }

      const result = await installClaudeStatusLine({
        settingsPath,
        compiledStatusLinePath: statuslinePath,
      });
      assert.equal(result.status, "invalid-deployment");
      assert.equal(await fs.promises.readFile(settingsPath, "utf8"), original);
      assert.equal(
        await fs.promises
          .stat(`${settingsPath}.ai-usage-monitor.bak`)
          .then(() => true, () => false),
        false,
      );
      assert.equal(
        (await fs.promises.readdir(directory)).some((name) =>
          name.startsWith(".settings.json."),
        ),
        false,
      );
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }
});
