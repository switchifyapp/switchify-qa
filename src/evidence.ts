import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodexDecision,
  ParentEvent,
  RunManifest,
  RunStatus,
  StepEvidence,
  WeirdFinding
} from "./types.js";

export function timestampForPath(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "goal";
}

export async function createRunDir(rootDir: string, goal: string, explicitRunDir?: string): Promise<string> {
  const runDir = explicitRunDir
    ? path.resolve(explicitRunDir)
    : path.join(rootDir, "runs", `${timestampForPath()}_${slugifyGoal(goal)}`);
  await mkdir(runDir, { recursive: true });
  return runDir;
}

export async function writeManifest(runDir: string, manifest: RunManifest): Promise<void> {
  await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(runDir, "goal.md"), `# Goal\n\n${manifest.goal}\n`, "utf8");
}

export async function appendEvent(runDir: string, event: ParentEvent): Promise<void> {
  await appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readEvents(runDir: string): Promise<ParentEvent[]> {
  try {
    const content = await readFile(path.join(runDir, "events.jsonl"), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ParentEvent);
  } catch {
    return [];
  }
}

export async function appendFindings(
  runDir: string,
  step: number,
  decision: CodexDecision
): Promise<void> {
  if (decision.weirdFindings.length === 0) {
    return;
  }

  const lines: string[] = [];
  for (const finding of decision.weirdFindings) {
    lines.push(renderFinding(step, finding));
  }
  await appendFile(path.join(runDir, "findings.md"), lines.join("\n"), "utf8");
}

function renderFinding(step: number, finding: WeirdFinding): string {
  const hints = finding.androidRepoSearchHints?.length
    ? finding.androidRepoSearchHints.map((hint) => `  - ${hint}`).join("\n")
    : "  - None provided";
  return [
    `## Step ${step}: ${finding.title}`,
    "",
    `- Severity: ${finding.severity}`,
    `- Suspected area: ${finding.suspectedArea ?? "Not specified"}`,
    `- Evidence: ${finding.evidence}`,
    `- Expected: ${finding.expected}`,
    `- Actual: ${finding.actual}`,
    "- Android repo search hints:",
    hints,
    ""
  ].join("\n");
}

export async function writeStepDecision(stepDir: string, decision: CodexDecision): Promise<void> {
  await writeFile(path.join(stepDir, "codex-decision.json"), `${JSON.stringify(decision, null, 2)}\n`, "utf8");
}

export async function writeSummary(input: {
  runDir: string;
  status: RunStatus;
  goal: string;
  stepCount: number;
  finalEvidence?: StepEvidence;
  findingsCount: number;
  androidRepoPath?: string;
  error?: string;
}): Promise<void> {
  const finalScreenshot = input.finalEvidence?.screenshotPath ?? "No screenshot captured";
  const followUpPrompt = renderFollowUpPrompt(input);
  const lines = [
    "# Switchify Codex QA Summary",
    "",
    `- Goal: ${input.goal}`,
    `- Final status: ${input.status}`,
    `- Steps: ${input.stepCount}`,
    `- Final screenshot: ${finalScreenshot}`,
    `- Findings: ${input.findingsCount}`,
    ...(input.error ? [`- Error: ${input.error}`] : []),
    "",
    "## Follow-Up Agent Prompt",
    "",
    "```text",
    followUpPrompt,
    "```",
    ""
  ];
  await writeFile(path.join(input.runDir, "summary.md"), lines.join("\n"), "utf8");
}

function renderFollowUpPrompt(input: {
  runDir: string;
  goal: string;
  findingsCount: number;
  androidRepoPath?: string;
}): string {
  const androidRepo = input.androidRepoPath ?? "Not configured";
  return [
    "Investigate these Switchify Android QA findings.",
    "",
    `Goal: ${input.goal}`,
    "",
    "Android repo:",
    androidRepo,
    "",
    "QA run:",
    input.runDir,
    "",
    `Findings recorded: ${input.findingsCount}`,
    "",
    "Start by reviewing the screenshots, events.jsonl, findings.md, and summary.md, then inspect the Android service/scanning code paths that match any search hints."
  ].join("\n");
}

export async function countFindings(runDir: string): Promise<number> {
  try {
    const content = await readFile(path.join(runDir, "findings.md"), "utf8");
    return (content.match(/^## Step /gm) ?? []).length;
  } catch {
    return 0;
  }
}
