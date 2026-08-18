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
} from "./domain";

export interface PublicationClient {
  connection(): Promise<ConnectionSummary>;
  categories(): Promise<Category[]>;
  prepare(input: DraftInput): Promise<PreparedDraft>;
  connect(
    input: ConnectionCredentials,
    onProgress?: (progress: ConnectionProgress) => void,
  ): Promise<ConnectionSummary>;
  requestPublish(
    input: PublishRequest,
    onProgress?: (progress: PublishProgress) => void,
  ): Promise<PublishApproval>;
  approvePublish(approval: PublishApproval): Promise<PublishResult>;
  cancelPublish(approval: PublishApproval): Promise<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fixtureHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256:${hex}`;
}

export function createFixtureClient(): PublicationClient {
  return {
    async connection() {
      return {
        provider: "tistory",
        connectionId: "default",
        label: "Tistory",
        blogHost: "preview.tistory.com",
        status: "ready",
      };
    },
    async categories() {
      return [
        { id: 0, name: "카테고리 없음" },
        { id: 101, name: "개발" },
        { id: 102, name: "기록" },
      ];
    },
    async prepare(input) {
      const canonical = JSON.stringify(input);
      const renderedHtml =
        input.content.format === "html"
          ? `<pre>${escapeHtml(input.content.body)}</pre>`
          : `<pre>${escapeHtml(input.content.body)}</pre>`;
      return {
        ...input,
        sourceHash: await fixtureHash(input.content.body),
        renderedHtmlHash: await fixtureHash(renderedHtml),
        draftHash: await fixtureHash(canonical),
        renderedHtml,
      };
    },
    async connect(input) {
      return {
        provider: "tistory",
        connectionId: "default",
        label: "Tistory",
        blogHost: input.blogHost,
        status: "ready",
      };
    },
    async requestPublish() {
      throw new Error("Fixture mode never creates a live publish request.");
    },
    async approvePublish() {
      throw new Error("Fixture mode never approves a live publish request.");
    },
    async cancelPublish() {},
  };
}
