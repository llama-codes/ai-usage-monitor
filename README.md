# AI Usage Monitor

AI Usage Monitor is a Windows system-tray app for subscription quota.
It shows quota remaining, reset times, and reading age for:

- Codex CLI
- Claude Code CLI

Claude Desktop is not supported. It does not run the Claude Code statusline
hook. OpenCode is excluded because it has no authoritative quota API.

## Requirements

- Windows 11 x64
- Node.js available on `PATH`
- Codex CLI installed and signed in
- Claude Code CLI installed

The Codex provider uses `codex app-server`. The Claude provider uses the
documented Claude Code statusline payload. The app does not read provider
credentials.

## Run for development

Install the pinned dependencies:

```powershell
npm ci
```

Build and open the manual tray harness:

```powershell
npm run spike:manual
```

Run the automated checks:

```powershell
npm run icons:verify
npm run typecheck
npm test
npm run spike:self-test
```

The manual harness builds the app before it starts. Close the panel to confirm
that the tray process and background polling continue.

## Package for Windows

Create the portable Windows x64 application:

```powershell
npm run package:win
```

The package is written to:

```text
out\AIUsageMonitor-win32-x64\
```

The executable is:

```text
out\AIUsageMonitor-win32-x64\AIUsageMonitor.exe
```

Verify the Windows GUI subsystem and run the packaged self-test:

```powershell
npm run verify:packaged
npm run smoke:packaged
```

This repository does not produce an installer or a signed release artifact.
Keep the packaged directory together when you move it.

## Set up Claude Code

The Claude card shows **Setup required** when the app-owned hook is missing.

1. Select **Install hook**.
2. Review the settings change.
3. Select **Confirm install**.
4. Open the Claude Code CLI in a terminal.
5. Accept workspace trust if Claude Code requests it.
6. Send one message and wait for the response.

The first click does not write settings. The confirmation allows the app to
add one `statusLine` entry to:

```text
%USERPROFILE%\.claude\settings.json
```

The app creates this sibling backup before the settings write:

```text
settings.json.ai-usage-monitor.bak
```

The app refuses to overwrite any existing custom `statusLine`. It also stops
if the backup already exists.

The compiled hook runs from this app-owned directory outside `app.asar`:

```text
%LOCALAPPDATA%\AIUsageMonitor\claude-hook\v1\
```

After confirmation, the card asks you to open Claude Code. Claude Code writes
the first cache when its CLI statusline receives a response. The card changes
to quota gauges after the next app refresh.

## Background behavior

The main process polls providers every 60 seconds. Polling continues when the
panel is closed.

The tray icon shows the worst connected quota window:

- Blue: less than 80 percent used
- Amber: at least 80 percent used
- Rose: at least 90 percent used

The app sends one notification at 80, 90, and 100 percent used for each quota
window and reset. Three consecutive refresh errors send one failure
notification. Selecting a notification opens the panel.

The tray menu provides **Refresh** and **Quit**. The app refreshes after system
resume and recreates the tray if Windows Explorer removes it.

## Missing and stale data

The app never represents missing data as zero usage.

- **Not connected** means the provider CLI is unavailable or signed out.
- **No data yet** means the provider has not produced a valid reading.
- **Error** means the latest read failed.
- **Stale** keeps the last Claude reading visible with its age.

Codex can refresh while its CLI is idle. Claude values update only when the
Claude Code CLI invokes the statusline. Claude readings become stale after
five minutes without a new cache. Claude Desktop cannot refresh them.

## Manual verification

After a development or packaged run:

1. Confirm the tray icon is visible.
2. Open the panel and compare Codex quota with Codex.
3. Complete Claude onboarding and send one Claude Code CLI message.
4. Confirm Claude gauges replace the setup card.
5. Select **Refresh** and confirm both providers update safely.
6. Close the panel and confirm the tray process continues.
7. Right-click the tray icon and test **Refresh** and **Quit**.
8. Confirm the panel does not appear in the taskbar or Alt-Tab.
9. Run the packaged app from a directory outside this repository.
10. Confirm the packaged app opens without a console window.
11. Leave the panel closed and observe memory for one hour.
12. Restart Windows Explorer and confirm the tray returns.

## Current limitations

- Windows 11 x64 is the only target.
- The package is portable and unsigned. There is no installer.
- Codex `account/rateLimits/read` is an experimental, version-specific method.
- Claude quota freezes when no Claude Code CLI response invokes the statusline.
- Node.js must remain available on `PATH` for the Claude hook.
- OpenCode is not shown because it has no authoritative quota API.
