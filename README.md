# Switchify QA

QA tooling for Switchify.

This repo contains QA tooling for ADB-driven manual scanning tests against debug builds of the Switchify Android app.

The TypeScript runner can take a human goal, ask an isolated read-only Codex child agent what to do next from screenshots and state, execute only approved Switchify ADB bridge actions, and write reproducible evidence under `runs/`.

## Requirements

- Android device with ADB enabled.
- Debug Switchify Android build installed.
- Switchify accessibility service enabled.
- Switchify debug ADB testing bridge available in the app.
- `adb` available on `PATH`, via `ANDROID_HOME`, via `ANDROID_SDK_ROOT`, or passed with `-AdbPath`.

## Commands

Install the TypeScript runner dependencies:

```powershell
npm install
```

Run a Codex-driven QA goal:

```powershell
npm run qa -- --goal "Open YouTube and watch a video" --device <device-id>
```

Validate the runner without priming or sending ADB actions:

```powershell
npm run qa -- --goal "Dry run validation" --dry-run
```

Run static checks:

```powershell
npm test
```

See [docs/codex-runner.md](docs/codex-runner.md) for the runner architecture, evidence format, and finding handoff workflow.

## Manual Harness

Run a device/environment check:

```powershell
.\switchify-manual-scan-qa.ps1 doctor -DeviceId <device-id>
```

Prime Switchify for manual item scan QA:

```powershell
.\switchify-manual-scan-qa.ps1 prime -DeviceId <device-id>
```

Send switch actions through the Switchify ADB testing bridge:

```powershell
.\switchify-manual-scan-qa.ps1 press next -DeviceId <device-id>
.\switchify-manual-scan-qa.ps1 press previous -DeviceId <device-id>
.\switchify-manual-scan-qa.ps1 press select -DeviceId <device-id>
```

Capture evidence:

```powershell
.\switchify-manual-scan-qa.ps1 capture -DeviceId <device-id>
```

Create a report from a run directory:

```powershell
.\switchify-manual-scan-qa.ps1 report -RunDir <run-dir>
```

Restore app data from a priming run:

```powershell
.\switchify-manual-scan-qa.ps1 restore -DeviceId <device-id> -RunDir <run-dir>
```

## Safety

`prime` backs up Switchify switch mappings and preferences before applying QA settings. Use `restore` with the run directory when finished if you need to return the app to its previous state.

Generated run evidence is written under `runs/` and intentionally ignored by git. That directory can contain screenshots, logcat output, window dumps, preference backups, device IDs, local paths, and app state.

Prefer the Switchify debug ADB testing bridge over raw `adb shell input keyevent` for scan actions. Synthetic key events do not reliably reach Android accessibility services.

Avoid `uiautomator dump` during service overlay testing unless you explicitly need it. UiAutomation can temporarily disrupt accessibility service state.
