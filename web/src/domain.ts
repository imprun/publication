export type ContentFormat = "markdown" | "html";
export type Visibility = "private" | "public";

export interface SourceContent {
  format: ContentFormat;
  body: string;
}

export interface DraftInput {
  provider: "tistory";
  connectionId: "default";
  title: string;
  content: SourceContent;
  tags: string[];
  categoryId: number;
}

export interface PreparedDraft extends DraftInput {
  sourceHash: string;
  renderedHtmlHash: string;
  draftHash: string;
  renderedHtml: string;
}

export interface Category {
  id: number;
  name: string;
}

export interface ConnectionSummary {
  provider: "tistory";
  connectionId: "default";
  label: string;
  blogHost: string;
  status: "ready" | "missing" | "expired";
}

export interface ConnectionCredentials {
  blogHost: string;
  accountId: string;
  password: string;
}

export type ConnectionProgress =
  | "saving_credentials"
  | "starting_login"
  | "waiting_for_kakao"
  | "checking_session";

export interface UploadedMedia {
  provider: "tistory";
  connectionId: "default";
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  width: number;
  height: number;
  attachmentRef: string;
  substitution: string;
}

export interface PublishRequest {
  draft: DraftInput;
  draftHash: string;
  visibility: Visibility;
  representativeImage?: File;
}

export interface PublishApproval {
  runId: string;
  taskId: string;
  title: string;
  expiresAt: string;
}

export interface PublishResult {
  provider: "tistory";
  connectionId: "default";
  postId: string;
  entryUrl: string;
  visibility: Visibility;
  representativeImageApplied: boolean;
}

export type PublishProgress = "uploading_media" | "requesting_approval";
