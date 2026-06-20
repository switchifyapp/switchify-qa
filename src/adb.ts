import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BridgeAction,
  CommandResult,
  DeviceInfo,
  StepEvidence,
  StepState
} from "./types.js";

const remoteTmp = "/sdcard/switchify_qa";
const interestingLogPattern =
  /Switchify|AndroidRuntime|ANR|FATAL EXCEPTION|Accessibility|ActivityManager|WindowManager|InputDispatcher/;

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; allowFailure?: boolean } = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result: CommandResult = {
        command,
        args,
        exitCode: code ?? 1,
        stdout,
        stderr
      };
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(new Error(formatCommandFailure(result)));
      } else {
        resolve(result);
      }
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export function formatCommandFailure(result: CommandResult): string {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return `${result.command} ${result.args.join(" ")} failed with exit ${result.exitCode}${
    output ? `\n${output}` : ""
  }`;
}

export async function resolveAdb(explicitPath?: string): Promise<string> {
  if (explicitPath) {
    return explicitPath;
  }

  const pathCheck = await runCommand("where", ["adb"], { allowFailure: true });
  const fromPath = pathCheck.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (fromPath) {
    return fromPath;
  }

  const candidateRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk") : undefined
  ].filter((value): value is string => Boolean(value));

  for (const root of candidateRoots) {
    const candidate = path.join(root, "platform-tools", "adb.exe");
    const exists = await runCommand("powershell", ["-NoProfile", "-Command", "Test-Path -LiteralPath $args[0]", candidate], {
      allowFailure: true
    });
    if (exists.stdout.trim().toLowerCase() === "true") {
      return candidate;
    }
  }

  throw new Error("ADB was not found. Pass --adb-path, add adb to PATH, or set ANDROID_HOME/ANDROID_SDK_ROOT.");
}

export async function listDevices(adbPath: string): Promise<DeviceInfo[]> {
  const result = await runCommand(adbPath, ["devices"]);
  return result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, state = "unknown"] = line.split(/\s+/);
      return { id: id ?? "", state };
    })
    .filter((device) => device.id.length > 0);
}

export async function resolveDevice(adbPath: string, requestedDevice?: string): Promise<string> {
  const devices = await listDevices(adbPath);
  if (requestedDevice) {
    const match = devices.find((device) => device.id === requestedDevice);
    if (!match) {
      throw new Error(`Device '${requestedDevice}' was not found. Connected devices: ${JSON.stringify(devices)}`);
    }
    if (match.state !== "device") {
      throw new Error(`Device '${requestedDevice}' is ${match.state}, not ready.`);
    }
    return requestedDevice;
  }

  const ready = devices.filter((device) => device.state === "device");
  if (ready.length === 0) {
    throw new Error("No ready Android devices are connected.");
  }
  if (ready.length > 1) {
    throw new Error(`Multiple Android devices are connected. Re-run with --device. Devices: ${JSON.stringify(ready)}`);
  }
  return ready[0]!.id;
}

export async function adb(
  adbPath: string,
  deviceId: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<CommandResult> {
  return runCommand(adbPath, ["-s", deviceId, ...args], options);
}

export async function captureEvidence(
  adbPath: string,
  deviceId: string,
  packageName: string,
  step: number,
  stepDir: string
): Promise<StepEvidence> {
  await mkdir(stepDir, { recursive: true });
  await adb(adbPath, deviceId, ["shell", "mkdir", "-p", remoteTmp]);

  const screenshotRemote = `${remoteTmp}/screen-${step}.png`;
  const screenshotPath = path.join(stepDir, "screen.png");
  const logcatPath = path.join(stepDir, "logcat.txt");
  const dumpsysWindowPath = path.join(stepDir, "dumpsys-window.txt");
  const statePath = path.join(stepDir, "state.json");
  const stateMarkdownPath = path.join(stepDir, "state.md");

  await adb(adbPath, deviceId, ["shell", "screencap", "-p", screenshotRemote]);
  await adb(adbPath, deviceId, ["pull", screenshotRemote, screenshotPath]);
  await adb(adbPath, deviceId, ["shell", "rm", "-f", screenshotRemote], { allowFailure: true });

  const dumpsysWindow = await adb(adbPath, deviceId, ["shell", "dumpsys", "window"], {
    allowFailure: true
  });
  await writeFile(dumpsysWindowPath, dumpsysWindow.stdout, "utf8");

  const logcatRaw = await adb(adbPath, deviceId, ["logcat", "-d", "-t", "900"], {
    allowFailure: true
  });
  const filteredLogcat = logcatRaw.stdout
    .split(/\r?\n/)
    .filter((line) => interestingLogPattern.test(line))
    .slice(-250)
    .join("\n");
  await writeFile(logcatPath, filteredLogcat, "utf8");

  const accessibilityRaw = (
    await adb(adbPath, deviceId, ["shell", "settings", "get", "secure", "enabled_accessibility_services"], {
      allowFailure: true
    })
  ).stdout.trim();
  const size = (await adb(adbPath, deviceId, ["shell", "wm", "size"], { allowFailure: true })).stdout.trim();
  const warnings = filteredLogcat
    .split(/\r?\n/)
    .filter((line) => / E | W |FATAL EXCEPTION|ANR|Exception|Error/.test(line))
    .slice(-80);

  const state: StepState = {
    timestamp: new Date().toISOString(),
    deviceId,
    packageName,
    accessibilityServiceEnabled: accessibilityRaw.includes(
      `${packageName}/com.enaboapps.switchify.service.core.SwitchifyAccessibilityService`
    ),
    accessibilityServicesRaw: accessibilityRaw,
    foreground: extractForegroundLines(dumpsysWindow.stdout),
    screenSize: size,
    warnings,
    screenshot: screenshotPath,
    logcat: logcatPath,
    dumpsysWindow: dumpsysWindowPath
  };

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(stateMarkdownPath, renderStateMarkdown(state), "utf8");

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

function extractForegroundLines(dumpsysWindow: string): string[] {
  return dumpsysWindow
    .split(/\r?\n/)
    .filter((line) => /mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity/.test(line))
    .map((line) => line.trim())
    .slice(0, 20);
}

function renderStateMarkdown(state: StepState): string {
  const warningLines = state.warnings.length ? state.warnings : ["No recent warnings captured."];
  return [
    "# Switchify Codex QA State",
    "",
    `- Timestamp: ${state.timestamp}`,
    `- Device: ${state.deviceId}`,
    `- Package: ${state.packageName}`,
    `- Accessibility service enabled: ${state.accessibilityServiceEnabled}`,
    `- Screen: ${state.screenSize}`,
    `- Screenshot: ${state.screenshot}`,
    "",
    "## Foreground",
    "```",
    ...state.foreground,
    "```",
    "",
    "## Recent Warnings / Errors",
    "```",
    ...warningLines,
    "```",
    ""
  ].join("\n");
}

export async function performBridgeAction(
  adbPath: string,
  deviceId: string,
  packageName: string,
  action: BridgeAction
): Promise<CommandResult> {
  return adb(
    adbPath,
    deviceId,
    [
      "shell",
      "am",
      "broadcast",
      "-a",
      "com.enaboapps.switchify.debug.PERFORM_SWITCH_ACTION",
      "-p",
      packageName,
      "--es",
      "action",
      action
    ],
    { allowFailure: true }
  );
}
