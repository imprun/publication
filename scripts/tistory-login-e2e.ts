import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TISTORY_ACCOUNT_ID_PATH,
  TISTORY_ACCOUNT_ID_REFERENCE,
  TISTORY_PASSWORD_PATH,
  TISTORY_PASSWORD_REFERENCE,
} from "../src/config.js";
import { normalizeTistoryHost } from "../src/providers/tistory/host.js";

const APP_KEY = "publication";
const LOGIN_ACTION = "connection.login";
const STATUS_ACTION = "connection.status";
const PREPARE_ACTION = "post.prepare";
const PUBLISH_ACTION = "post.publish";
const DEFAULT_MARKDOWN_PATH = resolve("examples", "tistory-e2e.md");

export interface LoginCredentials {
  accountId: string;
  password: string;
}

export interface ExampleDraft {
  provider: "tistory";
  connectionId: "default";
  title: string;
  markdown: string;
  tags: string[];
  categoryId: number;
}

interface CliOptions {
  context: string;
  blogHost: string;
  credentialsSource: { kind: "json"; path: string } | { kind: "env"; path: string };
  markdownPath: string;
  configureOnly: boolean;
}

interface RunView {
  run_id: string;
  state: string;
}

interface HumanTaskView {
  id: string;
  run_id: string;
  title: string;
  expires_at: string;
}

interface HumanTaskList {
  items: HumanTaskView[];
}

interface PrepareResult {
  draftHash: string;
}

interface ConnectionResult {
  authenticated: true;
  blogHost: string;
}

interface PostResult {
  postId: string;
  entryUrl: string;
  visibility: "private" | "public";
  representativeImageApplied: boolean;
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
    action_key: LOGIN_ACTION,
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

export function createExampleDraft(markdown: string, now = new Date()): ExampleDraft {
  if (!markdown.trim()) throw new Error("example Markdown must not be empty");
  return {
    provider: "tistory",
    connectionId: "default",
    title: `[publication E2E] ${now.toISOString()}`,
    markdown,
    tags: ["publication-e2e", "markdown"],
    categoryId: 0,
  };
}

export function privatePublishInput(draft: ExampleDraft, draftHash: string) {
  return { ...draft, draftHash, visibility: "private" as const };
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
      argument !== "--env" &&
      argument !== "--markdown"
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
      "usage: npm run e2e:tistory-login -- --context <name> --blog-host <host> (--credentials <json-file> | --env <env-file>) [--markdown <md-file>] [--configure-only]",
    );
  }
  const credentialsSource = credentialsPath
    ? ({ kind: "json", path: credentialsPath } as const)
    : ({ kind: "env", path: envPath as string } as const);
  return {
    context,
    blogHost,
    credentialsSource,
    markdownPath: values.get("--markdown") ?? DEFAULT_MARKDOWN_PATH,
    configureOnly,
  };
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

async function createRun(context: string, action: string, input: unknown): Promise<RunView> {
  return imprunJson<RunView>(
    context,
    [
      "run",
      "create",
      APP_KEY,
      action,
      "--input-file",
      "-",
      "--idempotency-key",
      `publication-e2e-${action}-${randomUUID()}`,
    ],
    input,
  );
}

function isSuccessfulRun(run: RunView): boolean {
  return run.state === "succeeded" || run.state === "success";
}

async function pendingHumanTask(
  context: string,
  runId: string,
): Promise<HumanTaskView | undefined> {
  const list = await imprunJson<HumanTaskList>(context, [
    "api",
    "human-tasks?state=pending&limit=100",
  ]);
  return list.items.find((candidate) => candidate.run_id === runId);
}

async function waitForTerminalRun(
  context: string,
  runId: string,
  timeoutMs: number,
  label: string,
  announceApproval = false,
): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  let announcedTaskId: string | undefined;
  while (Date.now() < deadline) {
    const run = await imprunJson<RunView>(context, ["run", "show", runId]);
    if (run.state !== "queued" && run.state !== "running") return run;
    if (announceApproval) {
      const task = await pendingHumanTask(context, runId).catch(() => undefined);
      if (task && task.id !== announcedTaskId) {
        announcedTaskId = task.id;
        console.log(
          `HumanTask ${task.id}: ${task.title}. Approve it in Imprun Cloud before ${task.expires_at}.`,
        );
      }
    }
    await sleep(1_000);
  }
  throw new Error(`timed out waiting for ${label} Run ${runId}`);
}

async function runAction<T>(
  context: string,
  action: string,
  input: unknown,
  timeoutMs: number,
  announceApproval = false,
): Promise<{ run: RunView; result: T }> {
  const created = await createRun(context, action, input);
  const terminal = await waitForTerminalRun(
    context,
    created.run_id,
    timeoutMs,
    action,
    announceApproval,
  );
  if (!isSuccessfulRun(terminal)) {
    throw new Error(`${action} Run ${terminal.run_id} ended in state ${terminal.state}`);
  }
  const result = await imprunJson<T>(context, ["run", "result", terminal.run_id]);
  return { run: terminal, result };
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

  const markdown = await readFile(options.markdownPath, "utf8");
  const draft = createExampleDraft(markdown);

  console.log(
    "Starting connection.login. Complete Kakao CAPTCHA in Browser Edge if shown, approve the device notification, then approve Tistory OAuth in Browser Edge if shown.",
  );
  const login = await runAction<ConnectionResult>(
    options.context,
    LOGIN_ACTION,
    runInput,
    21 * 60 * 1000,
  );
  const status = await runAction<ConnectionResult>(
    options.context,
    STATUS_ACTION,
    { provider: "tistory", connectionId: "default" },
    2 * 60 * 1000,
  );
  if (!status.result.authenticated) throw new Error("stored Tistory session is not authenticated");

  const prepared = await runAction<PrepareResult>(
    options.context,
    PREPARE_ACTION,
    draft,
    2 * 60 * 1000,
  );
  console.log(`Prepared private example post: ${draft.title}`);
  const published = await runAction<PostResult>(
    options.context,
    PUBLISH_ACTION,
    privatePublishInput(draft, prepared.result.draftHash),
    6 * 60 * 1000,
    true,
  );

  console.log(
    JSON.stringify(
      {
        loginRunId: login.run.run_id,
        statusRunId: status.run.run_id,
        prepareRunId: prepared.run.run_id,
        publishRunId: published.run.run_id,
        blogHost: status.result.blogHost,
        title: draft.title,
        postId: published.result.postId,
        entryUrl: published.result.entryUrl,
        visibility: published.result.visibility,
        representativeImageApplied: published.result.representativeImageApplied,
      },
      null,
      2,
    ),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
