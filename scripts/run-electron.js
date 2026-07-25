const { spawnSync } = require("node:child_process");
const electronPath = require("electron");

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [".", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
