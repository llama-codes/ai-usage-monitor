# Electron scaffold and tray verification

The accepted tray spike is folded into the product scaffold without changing
its focused-popup behavior.

## Pinned stack and packaging

The dependency versions were selected from the npm registry on 2026-07-25 and
are exact in `package.json` and `package-lock.json`:

- Electron `43.2.0`
- React and React DOM `19.2.8`
- Vite `8.1.5` with `@vitejs/plugin-react` `6.0.4`
- Tailwind CSS `4.3.3` with `@tailwindcss/vite` `4.3.3`
- TypeScript `7.0.2`

Windows packaging uses `@electron/packager` `20.0.4` with ASAR enabled. It
creates the x64 application at `out/AIUsageMonitor-win32-x64` and stores app
resources in `resources/app.asar`. Vite bundles the React renderer into
`dist/renderer`; TypeScript emits main and preload code into `dist/main` and
`dist/preload`.

The checked-in tray artwork is generated without third-party image tooling.
`assets/icons/tray-16.png` through `tray-48.png` supply native raster
representations for Windows display scales. `assets/icons/app.ico` contains
16, 20, 24, 32, 48, and 256 pixel representations and is passed to Electron
Packager for the executable.

To reproduce and verify the assets:

```powershell
npm run icons:generate
npm run icons:verify
```

The verifier decodes every PNG and ICO representation and checks dimensions,
transparency, opaque coverage, and luminance contrast. The runtime self-test
also confirms that Electron loads all checked-in tray representations. These
checks reject blank artwork but cannot prove how the Windows shell composites
an icon.

The hardened renderer boundary keeps `contextIsolation: true`,
`nodeIntegration: false`, and `sandbox: true`. The preload exposes only
`readQuota` and `forceRefresh`; it never exposes `ipcRenderer`. Main validates
the invoking frame and the exact forced-refresh payload.

## Automated checks

```powershell
npm ci
npm run icons:verify
npm run typecheck
npm run build:electron
npm run build:renderer
npm test
npm run spike:self-test
npm run package:win
npm run verify:packaged
npm run smoke:packaged
```

`spike:self-test` verifies the React renderer loads, Node globals are absent,
the exposed API has exactly two frozen methods, deterministic typed read and
forced-refresh IPC succeeds, the popup takes focus, 100 programmatic show/hide
cycles succeed, and hidden background ticks continue. The self-test injects a
Codex placeholder so it never depends on a local CLI or network response.
The positioning tests cover bottom, top, left, and right taskbars plus
negative-coordinate/high-DPI work areas. Contract tests cover payload shape,
percentages, Unix-second timestamps, and the `300` and `10080` duration IDs.

Normal app reads use the live Codex adapter described in
`docs/codex-provider.md`. Claude remains `not-connected` with no windows and an
implementation-pending error. `unsupported` is reserved for providers such as
the planned OpenCode placeholder. No usage value is invented while an adapter
is absent.

Programmatic toggles establish state reliability, not an absence of visible
flashing. A human must observe that criterion.

## Focused-popup acceptance

Run `npm run spike:manual` and inspect the JSON-line output (or set
`AUM_SPIKE_LOG` to a path inside this repository).

1. Confirm the panel appears and takes focus. The `popup-shown-focused` entry
   must say `"focused":true`.
2. Activate the **Refresh** button by mouse and keyboard. Confirm a `refresh`
   event with reason `"user"` is emitted.
3. Click outside the panel. Confirm `popup-blur` and then `popup-hidden` with
   reason `"blur"` are emitted promptly.
4. Leave the panel hidden and confirm `background-heartbeat` entries continue.
5. Confirm the blue-and-white gauge is visible in the Windows notification
   area on both light and dark taskbar themes. Also inspect the tray overflow.

## Manual environment checks

- Check taskbar and Alt-Tab: the panel must never appear in either.
- With the taskbar on every edge, click the real tray icon and confirm the panel
  stays inside that display's work area.
- Repeat on each monitor and at each configured scale factor.
- Toggle the real tray icon 100 times while watching for flash or drift.
- Right-click the tray icon; verify Refresh increments the visible counter and
  Quit exits every app process.
- Move the icon into the tray overflow and repeat positioning checks.
- Restart Explorer, then confirm the icon returns and remains functional.
- Suspend and resume Windows, then confirm ticks continue and tray controls work.

Do not restart Explorer or suspend the machine during automated verification.
Those checks alter the user's environment and remain manual.
