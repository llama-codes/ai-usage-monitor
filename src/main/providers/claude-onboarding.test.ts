import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deployClaudeHook,
  inspectClaudeSetup,
  installClaudeHook,
  resolveDeployedStatusLinePath,
  type ClaudeHookDeploymentOperations,
} from "./claude-onboarding";
import { buildClaudeStatusLineCommand } from "./claude-installer";

async function withTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "aum-onboarding-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

async function createSource(root: string): Promise<void> {
  const files = [
    ["scripts/statusline.js", "// statusline\n"],
    ["src/shared/claude-cache.js", "// cache\n"],
  ] as const;
  for (const [relativePath, contents] of files) {
    const target = path.join(root, relativePath);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, contents);
  }
}

function deploymentOptions(
  sourceRoot: string,
  destinationRoot: string,
  operations?: ClaudeHookDeploymentOperations,
) {
  return {
    trustedSourceBase: path.dirname(sourceRoot),
    sourceRoot,
    trustedDestinationBase: path.dirname(destinationRoot),
    destinationRoot,
    ...(operations ? { operations } : {}),
  };
}

test("classifies Claude setup without mistaking custom hooks for app-owned", async () => {
  await withTemporaryDirectory(async (directory) => {
    const settingsPath = path.join(directory, "settings.json");
    const deployedPath = path.join(
      directory,
      "AIUsageMonitor",
      "claude-hook",
      "v1",
      "scripts",
      "statusline.js",
    );
    await fs.promises.writeFile(settingsPath, "{\n  // existing setting\n}\n");
    assert.deepEqual(
      await inspectClaudeSetup({
        settingsPath,
        deployedStatusLinePath: deployedPath,
        cacheAvailable: true,
      }),
      { status: "missing" },
    );

    await fs.promises.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: buildClaudeStatusLineCommand(deployedPath),
        },
      }),
    );
    assert.deepEqual(
      await inspectClaudeSetup({
        settingsPath,
        deployedStatusLinePath: deployedPath,
        cacheAvailable: false,
      }),
      { status: "installed-pending" },
    );
    assert.deepEqual(
      await inspectClaudeSetup({
        settingsPath,
        deployedStatusLinePath: deployedPath,
        cacheAvailable: true,
      }),
      { status: "available" },
    );

    await fs.promises.writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "node custom.js" },
      }),
    );
    assert.deepEqual(
      await inspectClaudeSetup({
        settingsPath,
        deployedStatusLinePath: deployedPath,
        cacheAvailable: true,
      }),
      { status: "conflict" },
    );
  });
});

test("reports settings errors safely", async () => {
  await withTemporaryDirectory(async (directory) => {
    const deployedPath = path.join(directory, "statusline.js");
    const missing = await inspectClaudeSetup({
      settingsPath: path.join(directory, "missing.json"),
      deployedStatusLinePath: deployedPath,
      cacheAvailable: false,
    });
    assert.equal(missing.status, "error");
    if (missing.status === "error") {
      assert.match(missing.message, /Open Claude Code/u);
    }

    const invalidPath = path.join(directory, "invalid.json");
    await fs.promises.writeFile(invalidPath, "{ nope");
    const invalid = await inspectClaudeSetup({
      settingsPath: invalidPath,
      deployedStatusLinePath: deployedPath,
      cacheAvailable: false,
    });
    assert.equal(invalid.status, "error");
  });
});

test("deploys the complete hook layout and reuses a completed version", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    await createSource(sourceRoot);

    const first = await deployClaudeHook(
      deploymentOptions(sourceRoot, destinationRoot),
    );
    assert.deepEqual(first, {
      status: "deployed",
      statusLinePath: resolveDeployedStatusLinePath(destinationRoot),
    });
    const deployedStatusLine = path.join(
      destinationRoot,
      "scripts",
      "statusline.js",
    );
    const before = await fs.promises.stat(deployedStatusLine);
    const second = await deployClaudeHook(
      deploymentOptions(sourceRoot, destinationRoot),
    );
    assert.deepEqual(second, first);
    assert.equal(
      await fs.promises.readFile(deployedStatusLine, "utf8"),
      "// statusline\n",
    );
    assert.equal(
      (await fs.promises.stat(deployedStatusLine)).mtimeMs,
      before.mtimeMs,
    );
  });
});

test("replaces a stale deployment when packaged source bytes change", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    await createSource(sourceRoot);
    assert.equal(
      (
        await deployClaudeHook(
          deploymentOptions(sourceRoot, destinationRoot),
        )
      ).status,
      "deployed",
    );
    await fs.promises.writeFile(
      path.join(sourceRoot, "scripts", "statusline.js"),
      "// updated source\n",
    );

    assert.equal(
      (
        await deployClaudeHook(
          deploymentOptions(sourceRoot, destinationRoot),
        )
      ).status,
      "deployed",
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(destinationRoot, "scripts", "statusline.js"),
        "utf8",
      ),
      "// updated source\n",
    );
  });
});

test("repairs a partial fixed-version destination", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    await createSource(sourceRoot);
    await fs.promises.mkdir(
      path.join(destinationRoot, "scripts"),
      { recursive: true },
    );
    await fs.promises.writeFile(
      path.join(destinationRoot, "scripts", "statusline.js"),
      "// partial\n",
    );

    assert.equal(
      (
        await deployClaudeHook(
          deploymentOptions(sourceRoot, destinationRoot),
        )
      ).status,
      "deployed",
    );
    assert.equal(
      await fs.promises.readFile(
        path.join(destinationRoot, "src", "shared", "claude-cache.js"),
        "utf8",
      ),
      "// cache\n",
    );
  });
});

test("restores the displaced deployment when replacement rename fails", async () => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    await createSource(sourceRoot);
    assert.equal(
      (
        await deployClaudeHook(
          deploymentOptions(sourceRoot, destinationRoot),
        )
      ).status,
      "deployed",
    );
    const statuslinePath = path.join(
      destinationRoot,
      "scripts",
      "statusline.js",
    );
    await fs.promises.writeFile(statuslinePath, "// previous corrupt bytes\n");

    const operations: ClaudeHookDeploymentOperations = {
      readFile: fs.promises.readFile.bind(fs.promises),
      writeFile: fs.promises.writeFile.bind(fs.promises),
      mkdir: fs.promises.mkdir.bind(fs.promises),
      lstat: fs.promises.lstat.bind(fs.promises),
      rm: fs.promises.rm.bind(fs.promises),
      rename: async (from, to) => {
        const fromPath = String(from);
        const toPath = String(to);
        if (
          fromPath.includes(".tmp") &&
          path.resolve(toPath) === path.resolve(destinationRoot)
        ) {
          throw Object.assign(new Error("simulated replacement failure"), {
            code: "EACCES",
          });
        }
        await fs.promises.rename(from, to);
      },
    };
    const result = await deployClaudeHook(
      deploymentOptions(sourceRoot, destinationRoot, operations),
    );
    assert.equal(result.status, "error");
    assert.equal(
      await fs.promises.readFile(statuslinePath, "utf8"),
      "// previous corrupt bytes\n",
    );
    assert.deepEqual(
      (await fs.promises.readdir(path.dirname(destinationRoot))).filter(
        (entry) => entry.startsWith(".v1."),
      ),
      [],
    );
  });
});

test("rejects symlinked deployment roots and layout files", async (context) => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    const external = path.join(directory, "external");
    await createSource(sourceRoot);
    await fs.promises.mkdir(external, { recursive: true });
    await fs.promises.mkdir(path.dirname(destinationRoot), { recursive: true });
    try {
      await fs.promises.symlink(
        external,
        destinationRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        context.skip(`Symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const linkedRoot = await deployClaudeHook(
      deploymentOptions(sourceRoot, destinationRoot),
    );
    assert.equal(linkedRoot.status, "error");
    if (linkedRoot.status === "error") {
      assert.match(linkedRoot.message, /symlink|unsafe/u);
    }
  });

  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationRoot = path.join(directory, "local", "v1");
    const externalFile = path.join(directory, "external-statusline.js");
    await createSource(sourceRoot);
    await fs.promises.writeFile(externalFile, "// external\n");
    await fs.promises.mkdir(
      path.join(destinationRoot, "scripts"),
      { recursive: true },
    );
    await fs.promises.mkdir(
      path.join(destinationRoot, "src", "shared"),
      { recursive: true },
    );
    try {
      await fs.promises.symlink(
        externalFile,
        path.join(destinationRoot, "scripts", "statusline.js"),
        "file",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        context.skip(`File symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await fs.promises.writeFile(
      path.join(destinationRoot, "src", "shared", "claude-cache.js"),
      "// cache\n",
    );
    const linkedFile = await deployClaudeHook(
      deploymentOptions(sourceRoot, destinationRoot),
    );
    assert.equal(linkedFile.status, "error");
  });
});

test("rejects an app-owned ancestor junction below the trusted base", async (context) => {
  await withTemporaryDirectory(async (directory) => {
    const sourceRoot = path.join(directory, "source");
    const destinationBase = path.join(directory, "local");
    const appDirectory = path.join(destinationBase, "AIUsageMonitor");
    const destinationRoot = path.join(
      appDirectory,
      "claude-hook",
      "v1",
    );
    const external = path.join(directory, "external");
    await createSource(sourceRoot);
    await fs.promises.mkdir(destinationBase, { recursive: true });
    await fs.promises.mkdir(external, { recursive: true });
    try {
      await fs.promises.symlink(
        external,
        appDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "EPERM" || error.code === "EACCES")
      ) {
        context.skip(`Ancestor junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = await deployClaudeHook({
      trustedSourceBase: directory,
      sourceRoot,
      trustedDestinationBase: destinationBase,
      destinationRoot,
    });
    assert.equal(result.status, "error");
    assert.equal(
      await fs.promises
        .access(path.join(external, "claude-hook"))
        .then(() => true, () => false),
      false,
    );
  });
});

test("orchestrates deployment before the existing installer", async () => {
  const calls: string[] = [];
  const paths = {
    settingsPath: "C:\\test\\.claude\\settings.json",
    sourceBase: "C:\\",
    sourceRoot: "C:\\source",
    destinationBase: "C:\\local",
    destinationRoot: "C:\\local\\AIUsageMonitor\\claude-hook\\v1",
  };
  const result = await installClaudeHook({
    paths,
    deploy: async (options) => {
      calls.push(`deploy:${options.destinationRoot}`);
      return {
        status: "deployed",
        statusLinePath: `${options.destinationRoot}\\scripts\\statusline.js`,
      };
    },
    install: async (options) => {
      calls.push(`install:${options.compiledStatusLinePath}`);
      return { status: "installed", backupPath: "backup" };
    },
  });
  assert.deepEqual(result, { status: "installed-pending" });
  assert.deepEqual(calls, [
    `deploy:${paths.destinationRoot}`,
    `install:${paths.destinationRoot}\\scripts\\statusline.js`,
  ]);
});

test("does not call the installer when deployment fails", async () => {
  let installerCalled = false;
  const result = await installClaudeHook({
    paths: {
      settingsPath: "settings",
      sourceBase: "source-base",
      sourceRoot: "source",
      destinationBase: "destination-base",
      destinationRoot: "destination",
    },
    deploy: async () => ({ status: "error", message: "deploy failed" }),
    install: async () => {
      installerCalled = true;
      return { status: "installed", backupPath: "backup" };
    },
  });
  assert.deepEqual(result, { status: "error", message: "deploy failed" });
  assert.equal(installerCalled, false);
});
