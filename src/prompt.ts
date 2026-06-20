import path from "node:path";
import { bridgeActions, runnerActions, type ParentEvent, type StepEvidence } from "./types.js";

export function buildCodexPrompt(input: {
  goal: string;
  step: number;
  maxSteps: number;
  events: ParentEvent[];
  evidence: StepEvidence;
}): string {
  const eventSummary = input.events.length
    ? input.events
        .slice(-20)
        .map((event) => {
          const step = event.step === undefined ? "-" : event.step.toString();
          return `- step ${step}: ${event.action} -> ${event.result}${event.exitCode === undefined ? "" : ` (${event.exitCode})`}`;
        })
        .join("\n")
    : "No previous actions.";

  const warnings = input.evidence.state.warnings.length
    ? input.evidence.state.warnings.slice(-30).join("\n")
    : "No recent warnings captured.";

  const foreground = input.evidence.state.foreground.length
    ? input.evidence.state.foreground.join("\n")
    : "No foreground lines captured.";

  return [
    "You are an isolated QA decision agent for Switchify manual scanning over ADB.",
    "",
    "Rules:",
    "- Do not ask the user for input.",
    "- Do not run ADB or shell commands.",
    "- Choose exactly one allowed action.",
    "- Use only the same actions a single-switch user has in this QA profile.",
    "- Do not request system recovery actions such as Home, Back, app launch, search, or direct ADB commands.",
    "- Report weird behavior in weirdFindings, but continue toward the goal unless the run should stop.",
    "- Mark success=true only when the screenshot/state visibly satisfies the goal.",
    "- Return only JSON matching the provided schema.",
    "",
    `Goal: ${input.goal}`,
    `Step: ${input.step + 1} of ${input.maxSteps}`,
    "",
    `Allowed actions: ${runnerActions.join(", ")}`,
    `Switchify bridge actions the parent may execute: ${bridgeActions.join(", ")}`,
    "",
    "Previous actions:",
    eventSummary,
    "",
    "Current foreground:",
    "```",
    foreground,
    "```",
    "",
    `Accessibility service enabled: ${input.evidence.state.accessibilityServiceEnabled}`,
    `Screen size: ${input.evidence.state.screenSize}`,
    `Screenshot path: ${path.basename(input.evidence.screenshotPath)}`,
    "",
    "Recent warnings:",
    "```",
    warnings,
    "```",
    "",
    "Return JSON in this exact shape:",
    "```json",
    JSON.stringify(
      {
        observation: "What you see and whether it helps the goal.",
        action: "next",
        rationale: "Why this is the next best action.",
        success: false,
        confidence: 0.5,
        weirdFindings: []
      },
      null,
      2
    ),
    "```"
  ].join("\n");
}
