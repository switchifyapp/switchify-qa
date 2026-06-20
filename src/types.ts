export const runnerActions = [
  "next",
  "previous",
  "select",
  "home",
  "back",
  "capture",
  "stop"
] as const;

export const bridgeActions = ["next", "previous", "select", "home", "back"] as const;

export type RunnerAction = (typeof runnerActions)[number];
export type BridgeAction = (typeof bridgeActions)[number];

export type FindingSeverity = "info" | "warning" | "bug" | "critical";

export type WeirdFinding = {
  severity: FindingSeverity;
  title: string;
  evidence: string;
  expected: string;
  actual: string;
  suspectedArea?: string | null;
  androidRepoSearchHints?: string[];
};

export type CodexDecision = {
  observation: string;
  action: RunnerAction;
  rationale: string;
  success: boolean;
  confidence: number;
  weirdFindings: WeirdFinding[];
};

export type RunnerOptions = {
  goal: string;
  deviceId?: string;
  maxSteps: number;
  runDir?: string;
  packageName: string;
  prime: boolean;
  dryRun: boolean;
  codexModel?: string;
  androidRepoPath?: string;
  adbPath?: string;
};

export type RunManifest = {
  startedAt: string;
  goal: string;
  deviceId: string;
  packageName: string;
  maxSteps: number;
  primeMode: "prime-only" | "none";
  androidRepoPath?: string;
  runnerVersion: 1;
  dryRun: boolean;
};

export type CommandResult = {
  command: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DeviceInfo = {
  id: string;
  state: string;
};

export type StepEvidence = {
  step: number;
  stepDir: string;
  screenshotPath: string;
  statePath: string;
  stateMarkdownPath: string;
  logcatPath: string;
  dumpsysWindowPath: string;
  state: StepState;
};

export type StepState = {
  timestamp: string;
  deviceId: string;
  packageName: string;
  accessibilityServiceEnabled: boolean;
  accessibilityServicesRaw: string;
  foreground: string[];
  screenSize: string;
  warnings: string[];
  screenshot: string;
  logcat: string;
  dumpsysWindow: string;
};

export type ParentEvent = {
  step?: number;
  timestamp: string;
  action: string;
  result: "ok" | "failed" | "skipped";
  transport?: "adb_testing_bridge" | "codex" | "powershell" | "dry_run";
  exitCode?: number;
  output?: string;
  error?: string;
};

export type RunStatus = "success" | "stopped" | "max_steps" | "failed";
