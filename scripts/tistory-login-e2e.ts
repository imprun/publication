import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  TISTORY_ACCOUNT_ID_PATH,
  TISTORY_ACCOUNT_ID_REFERENCE,
  TISTORY_PASSWORD_PATH,
  TISTORY_PASSWORD_REFERENCE,
} from "../src/config.js";
import { normalizeTistoryHost } from "../src/providers/tistory/host.js";

const APP_KEY = "publication";
const ACTION_KEY = "connection.login";

export interface LoginCredentials {
  accountId: string;
  password: string;
}

interface CliOptions {
  context: string;
  blogHost: string;
  credentialsSource: { kind: "json"; path: string } | { kind: "env"; path: string };
  configureOnly: boolean;
}

interface RunView {
  run_id: string;
  state: string;
}

interface HumanTaskView {
  id: string;
  run_id: string;
  job_id: string;
  state: string;
  title: string;
  description?: string;
  expires_at: string;
}

interface HumanTaskList {
  items: HumanTaskView[];
}

type LoginProgress =
  | { kind: "human-task"; task: HumanTaskView }
  | { kind: "terminal"; run: RunView };

export function humanTaskDecisionRequest(
  taskId: string,
  answer: "approve" | "cancel",
): { args: string[]; input?: unknown } {
  if (answer === "approve") {
    return {
      args: ["human-task", "decide", taskId, "--outcome", "submit", "--value-file", "-"],
      input: { completed: true },
    };
  }
  return {
    args: ["human-task", "decide", taskId, "--outcome", "cancel"],
  };
}

export function parseCredentialsJson(source: string): LoginCredentials {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credentials JSON must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "accountId,password") {
    throw new Error("credentials JSON must contain only accountId and password");
  }
  if (typeof record.accountId !== "string" || record.accountId.trim().length === 0) {
    throw new Error("credentials accountId must be a non-empty string");
  }
  if (typeof record.password !== "string" || record.password.length === 0) {
    throw new Error("credentials password must be a non-empty string");
  }
  return { accountId: record.accountId.trim(), password: record.password };
}

export function parseCredentialsEnv(source: string): LoginCredentials {
  const values = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  const accountId = values.get("KAKAO_LOGINID");
  const password = values.get("KAKAO_LOGINPWD");
  if (!accountId?.trim()) throw new Error("KAKAO_LOGINID is missing from the env file");
  if (!password) throw new Error("KAKAO_LOGINPWD is missing from the env file");
  return { accountId: accountId.trim(), password };
}

export function credentialVariableRequests(credentials: LoginCredentials) {
  return [
    {
      path: TISTORY_ACCOUNT_ID_PATH,
      value: credentials.accountId,
      is_secret: true,
      app_key: APP_KEY,
      description: "Kakao account identifier for Tistory login",
    },
    {
      path: TISTORY_PASSWORD_PATH,
      value: credentials.password,
      is_secret: true,
      app_key: APP_KEY,
      description: "Kakao account password for Tistory login",
    },
  ];
}

export function loginInputConfigRequest() {
  return {
    action_key: ACTION_KEY,
    config: {
      accountId: TISTORY_ACCOUNT_ID_REFERENCE,
      password: TISTORY_PASSWORD_REFERENCE,
    },
    locked_keys: ["accountId", "password"],
  };
}

export function loginRunInput(blogHost: string) {
  return { blogHost: normalizeTistoryHost(blogHost) };
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let configureOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--configure-only") {
      configureOnly = true;
      continue;
    }
    if (
      argument !== "--context" &&
      argument !== "--blog-host" &&
      argument !== "--credentials" &&
      argument !== "--env"
    ) {
      throw new Error(`unknown argument: ${argument ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  const context = values.get("--context");
  const blogHost = values.get("--blog-host");
  const credentialsPath = values.get("--credentials");
  const envPath = values.get("--env");
  if (!context || !blogHost || Boolean(credentialsPath) === Boolean(envPath)) {
    throw new Error(
      "usage: npm run e2e:tistory-login -- --context <name> --blog-host <host> (--credentials <json-file> | --env <env-file>) [--configure-only]",
    );
  }
  const credentialsSource = credentialsPath
    ? ({ kind: "json", path: credentialsPath } as const)
    : ({ kind: "env", path: envPath as string } as const);
  return { context, blogHost, credentialsSource, configureOnly };
}

async function imprunJson<T>(
  context: string,
  args: string[],
  input?: unknown,
  sensitive = false,
): Promise<T> {
  const child = spawn("imprun", ["--context", context, "--json", "*", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    if (sensitive) throw new Error(`imprun secret provisioning failed with exit code ${exitCode}`);
    const detail = stderr.trim() || stdout.trim();
    throw new Error(detail || `imprun exited with code ${exitCode}`);
  }
  const body = stdout.trim();
  if (!body) return undefined as T;
  return JSON.parse(body) as T;
}

async function provisionCredentials(context: string, credentials: LoginCredentials) {
  for (const request of credentialVariableRequests(credentials)) {
    await imprunJson(
      context,
      ["api", "variables", "--method", "POST", "--input", "-"],
      request,
      true,
    );
  }
  await imprunJson(
    context,
    ["api", `apps/${APP_KEY}/input-configs`, "--method", "PUT", "--input", "-"],
    loginInputConfigRequest(),
  );
}

async function createLoginRun(context: string, blogHost: string): Promise<RunView> {
  return imprunJson<RunView>(
    context,
    [
      "run",
      "create",
      APP_KEY,
      ACTION_KEY,
      "--input-file",
      "-",
      "--idempotency-key",
      `publication-tistory-login-e2e-${randomUUID()}`,
    ],
    loginRunInput(blogHost),
  );
}

async function waitForLoginProgress(context: string, runId: string): Promise<LoginProgress> {
  const deadline = Date.now() + 11 * 60 * 1000;
  while (Date.now() < deadline) {
    const list = await imprunJson<HumanTaskList>(context, [
      "api",
      "human-tasks?state=pending&limit=100",
    ]);
    const task = list.items.find((candidate) => candidate.run_id === runId);
    if (task) return { kind: "human-task", task };
    const run = await imprunJson<RunView>(context, ["run", "show", runId]);
    if (run.state !== "queued" && run.state !== "running") {
      return { kind: "terminal", run };
    }
    await sleep(1_000);
  }
  throw new Error("timed out waiting for automatic login or additional verification");
}

async function decideHumanTask(context: string, task: HumanTaskView): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`HumanTask ${task.id}: ${task.title}`);
    if (task.description) console.log(task.description);
    console.log(`expires at ${task.expires_at}`);
    const answer = (
      await terminal.question(
        '카카오톡 또는 휴대전화에서 추가 인증을 마친 뒤 "approve"를 입력하세요. 취소하려면 "cancel": ',
      )
    )
      .trim()
      .toLowerCase();
    if (answer !== "approve" && answer !== "cancel") {
      throw new Error('HumanTask decision must be "approve" or "cancel"');
    }
    const request = humanTaskDecisionRequest(task.id, answer);
    await imprunJson(context, request.args, request.input, true);
  } finally {
    terminal.close();
  }
}

async function waitForTerminalRun(context: string, runId: string): Promise<RunView> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const run = await imprunJson<RunView>(context, ["run", "show", runId]);
    if (run.state !== "queued" && run.state !== "running") return run;
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for Run ${runId}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentialText = await readFile(options.credentialsSource.path, "utf8");
  const credentials =
    options.credentialsSource.kind === "json"
      ? parseCredentialsJson(credentialText)
      : parseCredentialsEnv(credentialText);
  const runInput = loginRunInput(options.blogHost);
  await provisionCredentials(options.context, credentials);
  credentials.accountId = "";
  credentials.password = "";
  console.log("Kakao credentials were stored as App-scoped Secret Variables.");
  console.log("The InputConfig contains only $var references; Run input contains only blogHost.");
  if (options.configureOnly) return;

  const run = await createLoginRun(options.context, runInput.blogHost);
  console.log(`Run ${run.run_id} created. Waiting for automatic login or additional verification.`);
  const progress = await waitForLoginProgress(options.context, run.run_id);
  let terminalRun: RunView;
  if (progress.kind === "human-task") {
    console.log(`Job ${progress.task.job_id} requires additional Kakao verification.`);
    await decideHumanTask(options.context, progress.task);
    terminalRun = await waitForTerminalRun(options.context, run.run_id);
  } else {
    terminalRun = progress.run;
  }
  console.log(JSON.stringify(terminalRun, null, 2));
  if (terminalRun.state !== "succeeded" && terminalRun.state !== "success") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
