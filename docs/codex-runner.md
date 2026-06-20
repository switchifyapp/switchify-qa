# Codex Runner

The Codex runner turns a plain-language QA goal into a controlled Switchify manual scanning run.

```powershell
npm run qa -- --goal "Open WhatsApp" --device <device-id> --max-steps 12
```

## Architecture

The TypeScript parent runner owns every side effect:

- ADB device resolution.
- Switchify QA priming through `switchify-manual-scan-qa.ps1`.
- Screenshot, logcat, and window-state capture.
- Switchify debug bridge broadcasts.
- Run directory writes.

Each child Codex invocation is a read-only decision agent. It receives a prompt, the current screenshot, recent state, recent warnings, and the action history. It returns one JSON decision matching `schemas/codex-decision.schema.json`.

## Isolation Model

Child Codex runs use:

```text
codex exec --ephemeral --sandbox read-only --ask-for-approval never
```

The child must not run ADB or shell commands. It can only choose one of:

```text
next
previous
select
capture
stop
```

The parent validates the action before doing anything. Unknown actions fail the run and write a summary.

The default runner is intentionally single-switch-only. It does not allow system recovery actions such as Home or Back; getting stuck should produce findings instead of escaping the workflow.

## Run Directory Format

Runs are stored under `runs/`, which is ignored by git.

```text
runs/
  2026-06-20_09-30-00_open-youtube/
    manifest.json
    goal.md
    summary.md
    findings.md
    events.jsonl
    step-000/
      screen.png
      state.json
      state.md
      logcat.txt
      dumpsys-window.txt
      codex-prompt.md
      codex-decision.json
      codex-events.jsonl
```

`events.jsonl` records parent-side actions. `findings.md` aggregates strange behavior reported by child Codex. `summary.md` is the handoff artifact for another debugging agent.

## Decision Schema

The child returns:

```json
{
  "observation": "What is visible now.",
  "action": "next",
  "rationale": "Why this action is best.",
  "success": false,
  "confidence": 0.75,
  "weirdFindings": []
}
```

Findings include severity, expected behavior, actual behavior, evidence, and optional Android repo search hints.

## Finding Handoff Workflow

When a run sees strange behavior, the runner keeps going by default. At the end, `summary.md` includes a follow-up prompt that points to:

- The QA run directory.
- `events.jsonl`.
- `findings.md`.
- Step screenshots and logs.
- The local Switchify Android repo path when configured.

That summary can be handed to another agent to inspect `switchify-android` and find the likely bug.

## Known Limitations

- The runner does not use `uiautomator dump` inside the Codex loop because it can disrupt accessibility service state.
- Child Codex success is visual/state based, not a deterministic assertion engine.
- The first version primes at start and leaves the device in the final state for debugging.
- The parent currently supports only the Switchify debug bridge actions needed for single-switch QA. System recovery actions are intentionally excluded from the default runner.
