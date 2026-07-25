# Electron tray spike verification

Electron is pinned to `43.2.0`, the latest stable version shown by the official
Electron releases index when this spike was created on 2026-07-25:
<https://releases.electronjs.org/release?channel=stable>.

## Automated checks

```powershell
npm ci
npm run typecheck
npm test
npm run spike:self-test
npm run package:win
npm run verify:packaged
```

`spike:self-test` verifies the popup takes focus, exercises 100 programmatic
show/hide cycles, confirms hidden background ticks, invokes the Refresh command,
loads the renderer, and reports the configured `skipTaskbar: true`/focusable
window state. The positioning unit tests cover bottom, top, left, and right
taskbars plus negative-coordinate/high-DPI display work areas.

Programmatic toggles establish state reliability, not an absence of visible
flashing. A human must observe that criterion.

## Focused-popup acceptance

Run `npm run spike:manual` and inspect the JSON-line output (or set
`AUM_SPIKE_LOG` to a path inside this repository).

1. Confirm the panel appears and takes focus. The `popup-shown-focused` entry
   must say `"focused":true`.
2. Activate the **Record interaction** button by mouse and keyboard. Confirm its
   visible count and the `button-click` event increment.
3. Click outside the panel. Confirm `popup-blur` and then `popup-hidden` with
   reason `"blur"` are emitted promptly.
4. Leave the panel hidden and confirm its **Background ticks** value increases
   when the panel is reopened.

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
