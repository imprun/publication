import type {
  Category,
  ConnectionCredentials,
  ConnectionProgress,
  ConnectionSummary,
  DraftInput,
  PreparedDraft,
  PublishApproval,
  PublishProgress,
  PublishRequest,
  PublishResult,
  UploadedMedia,
} from "./domain";
import type { PublicationClient } from "./fixture-client";

const APP_KEY = "publication";
const CONNECTION_RESOURCE_PATH = "connections/tistory/default/profile";
const ACCOUNT_ID_PATH = "connections/tistory/default/account-id";
const PASSWORD_PATH = "connections/tistory/default/password";
const ACCOUNT_ID_REFERENCE = `$var@app:${ACCOUNT_ID_PATH}`;
const PASSWORD_REFERENCE = `$var@app:${PASSWORD_PATH}`;
const TERMINAL_STATES = new Set(["succeeded", "completed", "failed", "cancelled", "canceled"]);

interface RunView {
  run_id: string;
  state: string;
}

interface HumanTask {
  id: string;
  run_id: string;
  title: string;
  expires_at: string;
}

interface ResourceView {
  app_key?: string;
  path?: string;
  value?: {
    blogHost?: string;
  };
}

interface ConnectionActionResult {
  blogHost: string;
  authenticated: true;
}

interface CategoryActionResult {
  categories: Category[];
}

export class PublicationApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function idempotencyKey(scope: string): string {
  return `publication-web-${scope}-${crypto.randomUUID()}`;
}

function normalizeBlogHost(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.tistory\.com$/.test(normalized)) {
    throw new Error("올바른 Tistory 블로그 주소를 입력해 주세요.");
  }
  return normalized;
}

function encodePath(value: string): string {
  return encodeURIComponent(value.trim());
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export interface CloudPublicationClientOptions {
  baseUrl: string;
  workspace: string;
  accessToken: () => string | undefined;
  onUnauthorized?: () => void | Promise<void>;
}

export class CloudPublicationClient implements PublicationClient {
  private readonly baseUrl: string;
  private readonly workspace: string;

  constructor(private readonly options: CloudPublicationClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.workspace = options.workspace;
  }

  private workspacePath(...parts: string[]): string {
    return `/api/w/${encodePath(this.workspace)}/${parts.map(encodePath).join("/")}`;
  }

  private invocationPath(...parts: string[]): string {
    return `/api/v1/workspaces/${encodePath(this.workspace)}/${parts.map(encodePath).join("/")}`;
  }

  private async request<T>(path: string, init: RequestInit = {}, sensitive = false): Promise<T> {
    const token = this.options.accessToken();
    if (!token) throw new PublicationApiError(401, "로그인이 필요합니다.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new PublicationApiError(0, "Imprun Cloud에 연결하지 못했습니다.");
    }
    const body = await response.text();
    if (!response.ok) {
      if (response.status === 401) await this.options.onUnauthorized?.();
      if (sensitive) {
        throw new PublicationApiError(response.status, "보안 정보를 저장하지 못했습니다.");
      }
      let message = body.trim() || response.statusText;
      try {
        const detail = JSON.parse(body) as { message?: string; error?: string };
        message = detail.message || detail.error || message;
      } catch {
        // Plain-text Core errors remain supported.
      }
      throw new PublicationApiError(response.status, message || "Cloud 요청에 실패했습니다.");
    }
    return (body ? JSON.parse(body) : undefined) as T;
  }

  private async createRun(action: string, input: unknown): Promise<RunView> {
    return this.request<RunView>(this.invocationPath("runs"), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey(action) },
      body: JSON.stringify({ app: APP_KEY, action, input }),
    });
  }

  private async showRun(runId: string): Promise<RunView> {
    return this.request<RunView>(this.invocationPath("runs", runId));
  }

  private async runResult<T>(runId: string): Promise<T> {
    return this.request<T>(this.invocationPath("runs", runId, "result"));
  }

  private async waitForRun<T>(run: RunView, action: string, timeoutMs = 15 * 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let current = run;
    while (Date.now() < deadline) {
      if (TERMINAL_STATES.has(current.state)) {
        if (current.state !== "succeeded" && current.state !== "completed") {
          throw new Error(`${action} 작업을 완료하지 못했습니다.`);
        }
        return this.runResult<T>(current.run_id);
      }
      await sleep(1_000);
      current = await this.showRun(current.run_id);
    }
    throw new Error(`${action} 작업의 제한 시간이 지났습니다.`);
  }

  private async resourceConnection(): Promise<ConnectionSummary> {
    const resources = await this.request<ResourceView[]>(this.workspacePath("resources"));
    const resource = resources.find(
      (candidate) => candidate.app_key === APP_KEY && candidate.path === CONNECTION_RESOURCE_PATH,
    );
    const blogHost = resource?.value?.blogHost;
    return {
      provider: "tistory",
      connectionId: "default",
      label: "Tistory",
      blogHost: blogHost || "연결되지 않음",
      status: blogHost ? "expired" : "missing",
    };
  }

  async connection(): Promise<ConnectionSummary> {
    const resource = await this.resourceConnection();
    if (resource.status === "missing") return resource;
    try {
      const run = await this.createRun("connection.status", {});
      const result = await this.waitForRun<ConnectionActionResult>(
        run,
        "Tistory 연결 확인",
        60_000,
      );
      return {
        provider: "tistory",
        connectionId: "default",
        label: "Tistory",
        blogHost: result.blogHost,
        status: result.authenticated ? "ready" : "expired",
      };
    } catch (error) {
      if (error instanceof PublicationApiError && (error.status === 401 || error.status === 403)) {
        throw error;
      }
      return resource;
    }
  }

  async categories(): Promise<Category[]> {
    const run = await this.createRun("metadata.categories", {});
    return (await this.waitForRun<CategoryActionResult>(run, "카테고리 조회", 60_000)).categories;
  }

  async prepare(input: DraftInput): Promise<PreparedDraft> {
    const run = await this.createRun("post.prepare", input);
    return this.waitForRun<PreparedDraft>(run, "게시 검토", 60_000);
  }

  async connect(
    input: ConnectionCredentials,
    onProgress?: (progress: ConnectionProgress) => void,
  ): Promise<ConnectionSummary> {
    const blogHost = normalizeBlogHost(input.blogHost);
    onProgress?.("saving_credentials");
    for (const variable of [
      {
        path: ACCOUNT_ID_PATH,
        value: input.accountId,
        description: "Kakao account identifier for Tistory login",
      },
      {
        path: PASSWORD_PATH,
        value: input.password,
        description: "Kakao account password for Tistory login",
      },
    ]) {
      await this.request(
        this.workspacePath("variables"),
        {
          method: "POST",
          body: JSON.stringify({ ...variable, is_secret: true, app_key: APP_KEY }),
        },
        true,
      );
    }
    await this.request(this.workspacePath("apps", APP_KEY, "input-configs"), {
      method: "PUT",
      body: JSON.stringify({
        action_key: "connection.login",
        config: { accountId: ACCOUNT_ID_REFERENCE, password: PASSWORD_REFERENCE },
        locked_keys: ["accountId", "password"],
      }),
    });
    onProgress?.("starting_login");
    const run = await this.createRun("connection.login", { blogHost });
    onProgress?.("waiting_for_kakao");
    const result = await this.waitForRun<ConnectionActionResult>(run, "Tistory 로그인");
    onProgress?.("checking_session");
    return {
      provider: "tistory",
      connectionId: "default",
      label: "Tistory",
      blogHost: result.blogHost,
      status: "ready",
    };
  }

  private async uploadMedia(file: File): Promise<UploadedMedia> {
    const allowed = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    if (!allowed.has(file.type)) throw new Error("지원하지 않는 대표 이미지 형식입니다.");
    if (file.size > 10_000_000) throw new Error("대표 이미지는 10MB 이하여야 합니다.");
    const run = await this.createRun("media.upload", {
      provider: "tistory",
      connectionId: "default",
      filename: file.name,
      mimeType: file.type,
      contentBase64: await fileToBase64(file),
    });
    return this.waitForRun<UploadedMedia>(run, "대표 이미지 업로드", 120_000);
  }

  private async pendingTask(runId: string): Promise<HumanTask | undefined> {
    const result = await this.request<{ items: HumanTask[] }>(
      `${this.workspacePath("human-tasks")}?state=pending&limit=100`,
    );
    return result.items.find((candidate) => candidate.run_id === runId);
  }

  async requestPublish(
    input: PublishRequest,
    onProgress?: (progress: PublishProgress) => void,
  ): Promise<PublishApproval> {
    let representativeImage: UploadedMedia | undefined;
    if (input.representativeImage) {
      onProgress?.("uploading_media");
      representativeImage = await this.uploadMedia(input.representativeImage);
    }
    onProgress?.("requesting_approval");
    const run = await this.createRun("post.publish", {
      ...input.draft,
      draftHash: input.draftHash,
      visibility: input.visibility,
      ...(representativeImage ? { representativeImage } : {}),
    });
    const deadline = Date.now() + 5 * 60_000;
    let current = run;
    while (Date.now() < deadline) {
      if (TERMINAL_STATES.has(current.state)) {
        throw new Error("승인 요청이 만들어지기 전에 게시 작업이 종료되었습니다.");
      }
      const task = await this.pendingTask(run.run_id);
      if (task) {
        return {
          runId: run.run_id,
          taskId: task.id,
          title: task.title,
          expiresAt: task.expires_at,
        };
      }
      await sleep(1_000);
      current = await this.showRun(run.run_id);
    }
    throw new Error("게시 승인 요청을 기다리는 시간이 지났습니다.");
  }

  async approvePublish(approval: PublishApproval): Promise<PublishResult> {
    await this.request(this.workspacePath("human-tasks", approval.taskId, "decision"), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey("publish-approval") },
      body: JSON.stringify({ outcome: "submit", value: { approved: true } }),
    });
    return this.waitForRun<PublishResult>(
      { run_id: approval.runId, state: "running" },
      "Tistory 게시",
    );
  }

  async cancelPublish(approval: PublishApproval): Promise<void> {
    await this.request(this.workspacePath("human-tasks", approval.taskId, "decision"), {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey("publish-cancel") },
      body: JSON.stringify({ outcome: "cancel" }),
    });
  }
}
