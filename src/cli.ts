#!/usr/bin/env node
import path from "node:path";
import { runQa } from "./runner.js";
import type { RunnerOptions } from "./types.js";

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    goal: "",
    maxSteps: 40,
    packageName: "com.enaboapps.switchify",
    prime: true,
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--goal":
        options.goal = readValue(argv, ++index, arg);
        break;
      case "--device":
        options.deviceId = readValue(argv, ++index, arg);
        break;
      case "--max-steps":
        options.maxSteps = parsePositiveInteger(readValue(argv, ++index, arg), arg);
        break;
      case "--run-dir":
        options.runDir = path.resolve(readValue(argv, ++index, arg));
        break;
      case "--package":
        options.packageName = readValue(argv, ++index, arg);
        break;
      case "--no-prime":
        options.prime = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        options.prime = false;
        break;
      case "--codex-model":
        options.codexModel = readValue(argv, ++index, arg);
        break;
      case "--android-repo":
        options.androidRepoPath = path.resolve(readValue(argv, ++index, arg));
        break;
      case "--adb-path":
        options.adbPath = path.resolve(readValue(argv, ++index, arg));
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.goal.trim()) {
    throw new Error("--goal is required");
  }
  if (options.maxSteps < 1) {
    throw new Error("--max-steps must be at least 1");
  }
  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Switchify Codex QA Runner

Usage:
  npm run qa -- --goal "<goal>" [options]

Options:
  --goal <string>              Required user-facing task goal.
  --device <adb-id>            Optional if exactly one ADB device is connected.
  --max-steps <number>         Default 40.
  --run-dir <path>             Optional explicit run directory.
  --package <package-name>     Default com.enaboapps.switchify.
  --no-prime                   Skip initial QA priming.
  --dry-run                    Validate run directory and decision parsing without mutating device.
  --codex-model <model>        Optional passthrough to codex exec -m.
  --android-repo <path>        Default ../switchify-android.
  --adb-path <path>            Optional explicit adb path.
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runQa(options);
  console.log(`Run status: ${result.status}`);
  console.log(`Run directory: ${result.runDir}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
