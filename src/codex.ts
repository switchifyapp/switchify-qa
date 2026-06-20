import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./adb.js";
import { validateCodexDecision } from "./schemas.js";
import type { CodexDecision } from "./types.js";

export async function runCodexDecision(input: {
  prompt: string;
  runDir: string;
  stepDir: string;
  screenshotPath: string;
  schemaPath: string;
  model?: string;
}): Promise<CodexDecision> {
  await mkdir(input.stepDir, { recursive: true });
  const promptPath = path.join(input.stepDir, "codex-prompt.md");
  const eventsPath = path.join(input.stepDir, "codex-events.jsonl");
  const lastMessagePath = path.join(input.stepDir, "codex-decision.json");
  await writeFile(promptPath, input.prompt, "utf8");

  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    input.runDir,
    "--image",
    input.screenshotPath,
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    lastMessagePath,
    "--json"
  ];
  if (input.model) {
    args.push("--model", input.model);
  }
  args.push("-");

  const result = await runCommand("codex", args, {
    input: input.prompt,
    allowFailure: true
  });
  await writeFile(eventsPath, result.stdout + result.stderr, "utf8");

  if (result.exitCode !== 0) {
    throw new Error(`codex exec failed with exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`.trim());
  }

  const raw = await readFile(lastMessagePath, "utf8");
  return validateCodexDecision(parseDecision(raw));
}

function parseDecision(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Codex decision file was empty");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1].trim());
    }
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]);
    }
    throw new Error("Codex decision was not valid JSON");
  }
}

export function fakeDecision(): CodexDecision {
  return validateCodexDecision(JSON.parse(JSON.stringify({
    observation: "Dry run validation decision.",
    action: "capture",
    rationale: "Dry run should not mutate the device.",
    success: false,
    confidence: 1,
    weirdFindings: []
  })));
}
