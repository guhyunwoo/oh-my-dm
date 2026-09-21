import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CheckConfig = {
  name: string;
  command: string;
  args: string[];
};

type HarnessConfig = {
  version: number;
  project: string;
  model: string;
  mode: "advisory";
  maxFiles: number;
  maxDiffChars: number;
  excludedPrefixes: string[];
  checks: CheckConfig[];
  constraints: string[];
};

type QuestionConfig = {
  triage: Record<string, unknown>;
  verify: Record<string, unknown>;
};

type CheckResult = {
  name: string;
  command: string;
  status: "passed" | "failed" | "timed_out";
  exitCode: number | null;
};

const toolDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(toolDirectory, "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function isSensitivePath(path: string, config: HarnessConfig): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    return true;
  }
  if (normalized.endsWith(".log") || normalized.endsWith(".tgz")) return true;
  return config.excludedPrefixes.some((prefix) => (
    normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix)
  ));
}

export function sanitizeText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/\b(apikey_|sk-or-|sk-)[A-Za-z0-9_-]+/g, "$1[REDACTED]")
    .replace(
      /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|COOKIE|SESSION)[A-Z0-9_]*\s*[=:]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    );
}

export function capText(value: string, maximum: number): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maximum)}\n[TRUNCATED]`,
    truncated: true,
  };
}

function run(root: string, command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function git(root: string, args: string[]): string {
  const result = run(root, "git", args);
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr.trim() || result.error?.message || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trimEnd();
}

function statusPath(line: string): string {
  const raw = line.slice(3).trim();
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1)! : raw;
  return renamed.replace(/^"|"$/g, "");
}

function collectRepositoryState(root: string, config: HarnessConfig) {
  const safeFiles = git(root, ["ls-files"])
    .split("\n")
    .filter(Boolean)
    .filter((path) => !isSensitivePath(path, config));
  const files = safeFiles.slice(0, config.maxFiles);
  const status = git(root, ["status", "--short", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: statusPath(line) }))
    .filter(({ path }) => !isSensitivePath(path, config));

  return {
    name: config.project,
    branch: git(root, ["branch", "--show-current"]),
    status,
    trackedFiles: files,
    trackedFilesTruncated: safeFiles.length > config.maxFiles,
  };
}

function collectChanges(root: string, config: HarnessConfig) {
  const changedFiles = git(root, ["diff", "--name-only", "HEAD"])
    .split("\n")
    .filter(Boolean)
    .filter((path) => !isSensitivePath(path, config));
  const status = git(root, ["status", "--short", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ code: line.slice(0, 2), path: statusPath(line) }))
    .filter(({ path }) => !isSensitivePath(path, config));
  const rawDiff = git(root, ["diff", "--no-ext-diff", "--unified=1", "HEAD", "--"]);
  const filteredDiff = filterDiff(rawDiff, config);
  const capped = capText(sanitizeText(filteredDiff), config.maxDiffChars);

  return {
    files: [...new Set([...changedFiles, ...status.map(({ path }) => path)])],
    status,
    diff: capped.text,
    diffTruncated: capped.truncated,
    untrackedFileContentsIncluded: false,
  };
}

function filterDiff(diff: string, config: HarnessConfig): string {
  const sections = diff.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      const match = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return !match || !isSensitivePath(match[2]!, config);
    })
    .join("");
}

export function buildRequest(
  model: string,
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
) {
  return { model, state, questions };
}

function callJev(root: string, request: ReturnType<typeof buildRequest>) {
  const result = run(root, "jev", ["raw"], `${JSON.stringify(request)}\n`);
  if (result.status !== 0 || result.error) {
    throw new Error(result.stderr.trim() || result.error?.message || "jev raw failed");
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function runChecks(root: string, checks: CheckConfig[]): CheckResult[] {
  return checks.map((check) => {
    const result = run(root, check.command, check.args);
    const status = result.signal === "SIGTERM"
      ? "timed_out"
      : result.status === 0 ? "passed" : "failed";
    return {
      name: check.name,
      command: [check.command, ...check.args].join(" "),
      status,
      exitCode: result.status,
    };
  });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const root = process.env.JEV_HARNESS_ROOT
    ? resolve(process.env.JEV_HARNESS_ROOT)
    : defaultRoot;
  const config = readJson<HarnessConfig>(resolve(root, ".harness/config.json"));
  const questions = readJson<QuestionConfig>(resolve(root, ".harness/questions.json"));
  const command = process.argv[2];
  const task = process.argv.slice(3).join(" ").trim();

  if (!command || !["preflight", "triage", "verify"].includes(command)) {
    throw new Error("Usage: npm run harness -- <preflight|triage|verify> <task>");
  }
  if (!task) throw new Error("A task description is required.");

  const repository = collectRepositoryState(root, config);
  if (command === "preflight") {
    print({ mode: config.mode, task, repository, constraints: config.constraints });
    return;
  }

  if (command === "triage") {
    const state = { task, repository, constraints: config.constraints };
    const response = callJev(root, buildRequest(config.model, state, questions.triage));
    print({ mode: config.mode, task, response });
    return;
  }

  const checks = runChecks(root, config.checks);
  const changes = collectChanges(root, config);
  const state = {
    task,
    repository: { name: repository.name, branch: repository.branch },
    changes,
    verification: { checks },
    constraints: config.constraints,
  };
  const response = callJev(root, buildRequest(config.model, state, questions.verify));
  print({ mode: config.mode, task, checks, response });
  if (checks.some(({ status }) => status !== "passed")) process.exitCode = 1;
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`jev-harness: ${message}\n`);
    process.exitCode = 1;
  });
}
