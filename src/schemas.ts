import { runnerActions, type CodexDecision, type WeirdFinding } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateFinding(value: unknown, index: number): WeirdFinding {
  if (!isRecord(value)) {
    throw new Error(`weirdFindings[${index}] must be an object`);
  }
  const severity = value.severity;
  if (
    severity !== "info" &&
    severity !== "warning" &&
    severity !== "bug" &&
    severity !== "critical"
  ) {
    throw new Error(`weirdFindings[${index}].severity is invalid`);
  }
  for (const key of ["title", "evidence", "expected", "actual"] as const) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      throw new Error(`weirdFindings[${index}].${key} must be a non-empty string`);
    }
  }
  if (value.suspectedArea !== undefined && typeof value.suspectedArea !== "string") {
    throw new Error(`weirdFindings[${index}].suspectedArea must be a string`);
  }
  if (
    value.androidRepoSearchHints !== undefined &&
    !isStringArray(value.androidRepoSearchHints)
  ) {
    throw new Error(`weirdFindings[${index}].androidRepoSearchHints must be a string array`);
  }
  return {
    severity,
    title: value.title as string,
    evidence: value.evidence as string,
    expected: value.expected as string,
    actual: value.actual as string,
    suspectedArea: value.suspectedArea,
    androidRepoSearchHints: value.androidRepoSearchHints
  };
}

export function validateCodexDecision(value: unknown): CodexDecision {
  if (!isRecord(value)) {
    throw new Error("Codex decision must be a JSON object");
  }
  const observation = value.observation;
  const action = value.action;
  const rationale = value.rationale;
  const success = value.success;
  const confidence = value.confidence;
  const weirdFindings = value.weirdFindings;

  if (typeof observation !== "string" || observation.trim().length === 0) {
    throw new Error("observation must be a non-empty string");
  }
  if (!runnerActions.includes(action as never)) {
    throw new Error(`action must be one of: ${runnerActions.join(", ")}`);
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new Error("rationale must be a non-empty string");
  }
  if (typeof success !== "boolean") {
    throw new Error("success must be a boolean");
  }
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error("confidence must be a number from 0 to 1");
  }
  if (!Array.isArray(weirdFindings)) {
    throw new Error("weirdFindings must be an array");
  }

  return {
    observation,
    action: action as CodexDecision["action"],
    rationale,
    success,
    confidence,
    weirdFindings: weirdFindings.map(validateFinding)
  };
}
