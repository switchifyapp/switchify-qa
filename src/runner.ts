import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureEvidence,
  performBridgeAction,
  resolveAdb,
  resolveDevice,
  runCommand
} from "./adb.js";
import { fakeDecision, runCodexDecision } from "./codex.js";
import {
  appendEvent,
  appendFindings,
  countFindings,
  createRunDir,
  readEvents,
  writeManifest,
  writeStepDecision,
  writeSummary
} from "./evidence.js";
import { buildCodexPrompt } from "./prompt.js";
import { bridgeActions, type BridgeAction, type CodexDecision, type RunnerOptions, type StepEvidence } from "./types.js";

export async function runQa(options: RunnerOptions): Promise<{ runDir: string; status: string }> {
  const rootDir = process.cwd();
  const adbPath = options.dryRun
    ? await resolveAdb(options.adbPath).catch(() => "dry-run-adb")
    : await resolveAdb(options.adbPath);
  const deviceId = options.dryRun
    ? await resolveDevice(adbPath, options.deviceId).catch(() => options.deviceId ?? "dry-run-device")
    : await resolveDevice(adbPath, options.deviceId);
  const runDir = await createRunDir(rootDir, options.goal, options.runDir);
  const schemaPath = path.join(rootDir, "schemas", "codex-decision.schema.json");
  const androidRepoPath = options.androidRepoPath ?? await defaultAndroidRepoPath(rootDir);
  let stepsCompleted = 0;

  await writeManifest(runDir, {
    startedAt: new Date().toISOString(),
    goal: options.goal,
    deviceId,
    packageName: options.packageName,
    maxSteps: options.maxSteps,
    primeMode: options.prime ? "prime-only" : "none",
    androidRepoPath,
    runnerVersion: 1,
    dryRun: options.dryRun
  });
  await rm(path.join(runDir, "findings.md"), { force: true });

  let finalEvidence: StepEvidence | undefined;
  try {
    if (options.prime && !options.dryRun) {
      await primeSwitchify(deviceId, runDir);
    } else {
      await appendEvent(runDir, {
        timestamp: new Date().toISOString(),
        action: "prime",
        result: "skipped",
        transport: options.dryRun ? "dry_run" : "powershell",
        output: options.dryRun ? "Dry run does not prime Switchify." : "Priming disabled."
      });
    }

    for (let step = 0; step < options.maxSteps; step += 1) {
      const stepDir = path.join(runDir, `step-${step.toString().padStart(3, "0")}`);
      const evidence = options.dryRun
        ? await captureDryRunEvidence(deviceId, options.packageName, step, stepDir)
        : await captureEvidence(adbPath, deviceId, options.packageName, step, stepDir);
      finalEvidence = evidence;
      stepsCompleted = step + 1;
      await appendEvent(runDir, {
        step,
        timestamp: new Date().toISOString(),
        action: "capture",
        result: "ok"
      });

      const events = await readEvents(runDir);
      const prompt = buildCodexPrompt({
        goal: options.goal,
        step,
        maxSteps: options.maxSteps,
        events,
        evidence
      });

      const decision = options.dryRun
        ? await writeDryRunDecision(stepDir, prompt, fakeDecision())
        : await runCodexDecision({
            prompt,
            runDir,
            stepDir,
            screenshotPath: evidence.screenshotPath,
            schemaPath,
            model: options.codexModel
          });
      await appendFindings(runDir, step, decision);

      if (decision.success) {
        await finalize(runDir, "success", options, step + 1, finalEvidence, androidRepoPath);
        return { runDir, status: "success" };
      }
      if (decision.action === "stop") {
        await finalize(runDir, "stopped", options, step + 1, finalEvidence, androidRepoPath);
        return { runDir, status: "stopped" };
      }
      if (decision.action === "capture") {
        await appendEvent(runDir, {
          step,
          timestamp: new Date().toISOString(),
          action: "capture",
          result: "skipped",
          output: "Child requested capture; parent will capture at next step."
        });
        continue;
      }

      await executeDecisionAction(adbPath, deviceId, options.packageName, runDir, step, decision, options.dryRun);
    }

    await finalize(runDir, "max_steps", options, options.maxSteps, finalEvidence, androidRepoPath);
    return { runDir, status: "max_steps" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSummary({
      runDir,
      status: "failed",
      goal: options.goal,
      stepCount: stepsCompleted,
      finalEvidence,
      findingsCount: await countFindings(runDir),
      androidRepoPath,
      error: message
    });
    await appendEvent(runDir, {
      timestamp: new Date().toISOString(),
      action: "runner",
      result: "failed",
      error: message
    });
    throw error;
  }
}

async function primeSwitchify(deviceId: string, runDir: string): Promise<void> {
  const result = await runCommand(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ".\\switchify-manual-scan-qa.ps1",
      "prime",
      "-DeviceId",
      deviceId,
      "-RunDir",
      runDir
    ],
    { allowFailure: true }
  );
  await appendEvent(runDir, {
    timestamp: new Date().toISOString(),
    action: "prime",
    result: result.exitCode === 0 ? "ok" : "failed",
    transport: "powershell",
    exitCode: result.exitCode,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n")
  });
  if (result.exitCode !== 0) {
    throw new Error(`prime failed with exit ${result.exitCode}`);
  }
}

async function executeDecisionAction(
  adbPath: string,
  deviceId: string,
  packageName: string,
  runDir: string,
  step: number,
  decision: CodexDecision,
  dryRun: boolean
): Promise<void> {
  if (!bridgeActions.includes(decision.action as BridgeAction)) {
    throw new Error(`Unsupported action for bridge execution: ${decision.action}`);
  }
  if (dryRun) {
    await appendEvent(runDir, {
      step,
      timestamp: new Date().toISOString(),
      action: decision.action,
      result: "skipped",
      transport: "dry_run",
      output: "Dry run does not send ADB bridge actions."
    });
    return;
  }

  const result = await performBridgeAction(adbPath, deviceId, packageName, decision.action as BridgeAction);
  await appendEvent(runDir, {
    step,
    timestamp: new Date().toISOString(),
    action: decision.action,
    result: result.exitCode === 0 ? "ok" : "failed",
    transport: "adb_testing_bridge",
    exitCode: result.exitCode,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n")
  });
  if (result.exitCode !== 0) {
    throw new Error(`ADB bridge action '${decision.action}' failed with exit ${result.exitCode}`);
  }
}

async function writeDryRunDecision(
  stepDir: string,
  prompt: string,
  decision: CodexDecision
): Promise<CodexDecision> {
  await writeFile(path.join(stepDir, "codex-prompt.md"), prompt, "utf8");
  await writeStepDecision(stepDir, decision);
  await writeFile(path.join(stepDir, "codex-events.jsonl"), "", "utf8");
  return decision;
}

async function captureDryRunEvidence(
  deviceId: string,
  packageName: string,
  step: number,
  stepDir: string
): Promise<StepEvidence> {
  await mkdir(stepDir, { recursive: true });
  const screenshotPath = path.join(stepDir, "screen.png");
  const logcatPath = path.join(stepDir, "logcat.txt");
  const dumpsysWindowPath = path.join(stepDir, "dumpsys-window.txt");
  const statePath = path.join(stepDir, "state.json");
  const stateMarkdownPath = path.join(stepDir, "state.md");
  await writeFile(screenshotPath, "", "utf8");
  await writeFile(logcatPath, "Dry run: no logcat captured.\n", "utf8");
  await writeFile(dumpsysWindowPath, "Dry run: no dumpsys captured.\n", "utf8");
  const state = {
    timestamp: new Date().toISOString(),
    deviceId,
    packageName,
    accessibilityServiceEnabled: true,
    accessibilityServicesRaw: "dry-run",
    foreground: ["dry-run foreground"],
    screenSize: "dry-run",
    warnings: [],
    screenshot: screenshotPath,
    logcat: logcatPath,
    dumpsysWindow: dumpsysWindowPath
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(stateMarkdownPath, "# Dry Run State\n", "utf8");
  return {
    step,
    stepDir,
    screenshotPath,
    statePath,
    stateMarkdownPath,
    logcatPath,
    dumpsysWindowPath,
    state
  };
}

async function finalize(
  runDir: string,
  status: "success" | "stopped" | "max_steps",
  options: RunnerOptions,
  stepCount: number,
  finalEvidence: StepEvidence | undefined,
  androidRepoPath: string | undefined
): Promise<void> {
  await writeSummary({
    runDir,
    status,
    goal: options.goal,
    stepCount,
    finalEvidence,
    findingsCount: await countFindings(runDir),
    androidRepoPath
  });
}

async function defaultAndroidRepoPath(rootDir: string): Promise<string | undefined> {
  const candidate = path.resolve(rootDir, "..", "switchify-android");
  try {
    await access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}
