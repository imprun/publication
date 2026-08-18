import { type ChangeEvent, type FormEvent, useEffect, useId, useRef, useState } from "react";
import type {
  Category,
  ConnectionProgress,
  ConnectionSummary,
  ContentFormat,
  DraftInput,
  PreparedDraft,
  PublishApproval,
  PublishProgress,
  PublishResult,
  Visibility,
} from "./domain";
import type { PublicationClient } from "./fixture-client";
import { Icon } from "./icons";

interface AppProps {
  client: PublicationClient;
  fixtureMode: boolean;
  accountLabel?: string;
  accountSettingsUrl?: string;
  onSignOut?: () => void;
  onChangeCloudTarget?: () => void;
}

const navigation = [
  { id: "compose" as const, label: "새 게시", icon: "document" as const },
  { id: "connections" as const, label: "연결", icon: "link" as const },
];

function fileTitle(filename: string): string {
  return filename
    .replace(/\.(md|markdown|html?|htm)$/i, "")
    .replaceAll(/[-_]+/g, " ")
    .trim();
}

function detectFormat(file: File): ContentFormat | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html";
  if (file.type === "text/markdown") return "markdown";
  if (file.type === "text/html") return "html";
  return null;
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

function previewDocument(renderedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{box-sizing:border-box;margin:0;padding:16px;color:#17231d;background:#fff;font:14px/1.65 Pretendard,system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.7 ui-monospace,monospace}table{max-width:100%;border-collapse:collapse}th,td{padding:6px;border:1px solid #dce4df}</style></head><body>${renderedHtml}</body></html>`;
}

const connectionProgressLabels: Record<ConnectionProgress, string> = {
  saving_credentials: "카카오 계정을 안전하게 저장하고 있습니다.",
  starting_login: "격리된 로그인 브라우저를 시작하고 있습니다.",
  waiting_for_kakao: "카카오톡으로 전송된 로그인 요청을 승인해 주세요.",
  checking_session: "Tistory 관리 세션을 확인하고 있습니다.",
};

const publishProgressLabels: Record<PublishProgress, string> = {
  uploading_media: "대표 이미지를 Tistory에 업로드하고 있습니다.",
  requesting_approval: "게시 내용을 고정하고 승인 요청을 만들고 있습니다.",
};

export function App({
  client,
  fixtureMode,
  accountLabel = "Imprun 계정",
  accountSettingsUrl,
  onSignOut,
  onChangeCloudTarget,
}: AppProps) {
  const [activeView, setActiveView] = useState<(typeof navigation)[number]["id"]>("compose");
  const sourceInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [blogHost, setBlogHost] = useState("");
  const [accountId, setAccountId] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [connectionProgress, setConnectionProgress] = useState<ConnectionProgress | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sourceFormat, setSourceFormat] = useState<ContentFormat>("markdown");
  const [sourceBody, setSourceBody] = useState("");
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [categoryId, setCategoryId] = useState(0);
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverName, setCoverName] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedDraft | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [publishProgress, setPublishProgress] = useState<PublishProgress | null>(null);
  const [publishApproval, setPublishApproval] = useState<PublishApproval | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    let active = true;
    client
      .connection()
      .then(async (nextConnection) => {
        if (!active) return;
        setConnection(nextConnection);
        if (nextConnection.blogHost !== "연결되지 않음") setBlogHost(nextConnection.blogHost);
        if (nextConnection.status === "ready") {
          const nextCategories = await client.categories();
          if (!active) return;
          setCategories(nextCategories);
          setCategoryId(nextCategories[0]?.id ?? 0);
        }
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : "연결 정보를 불러오지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  function invalidatePrepared() {
    setPrepared(null);
    setPrepareError(null);
  }

  function draftInput(): DraftInput {
    return {
      provider: "tistory",
      connectionId: "default",
      title: title.trim(),
      content: { format: sourceFormat, body: sourceBody },
      tags: parseTags(tags),
      categoryId,
    };
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!blogHost.trim() || !accountId.trim() || !password || connecting) return;
    setConnecting(true);
    setConnectionError(null);
    setConnectionProgress("saving_credentials");
    try {
      const nextConnection = await client.connect(
        { blogHost, accountId: accountId.trim(), password },
        setConnectionProgress,
      );
      setConnection(nextConnection);
      setShowConnectionForm(false);
      setConfirmDisconnect(false);
      setBlogHost(nextConnection.blogHost);
      const nextCategories = await client.categories();
      setCategories(nextCategories);
      setCategoryId(nextCategories[0]?.id ?? 0);
    } catch (error: unknown) {
      setConnectionError(
        error instanceof Error ? error.message : "Tistory 연결을 완료하지 못했습니다.",
      );
    } finally {
      setAccountId("");
      setPassword("");
      setConnectionProgress(null);
      setConnecting(false);
    }
  }

  async function disconnect() {
    if (disconnecting || connecting) return;
    setDisconnecting(true);
    setConnectionError(null);
    try {
      setConnection(await client.disconnect());
      setCategories([]);
      setCategoryId(0);
      setBlogHost("");
      setConfirmDisconnect(false);
      setShowConnectionForm(true);
    } catch (error: unknown) {
      setConnectionError(
        error instanceof Error ? error.message : "Tistory 연결을 해제하지 못했습니다.",
      );
    } finally {
      setDisconnecting(false);
    }
  }

  async function chooseSource(file: File | null) {
    setSourceError(null);
    if (!file) return;
    const format = detectFormat(file);
    if (!format) {
      setSourceError("Markdown(.md) 또는 HTML(.html) 파일만 선택할 수 있습니다.");
      return;
    }
    if (file.size > 2_000_000) {
      setSourceError("원문 파일은 2MB 이하여야 합니다.");
      return;
    }
    const body = await file.text();
    if (!body.trim()) {
      setSourceError("빈 문서는 게시할 수 없습니다.");
      return;
    }
    setSourceFormat(format);
    setSourceBody(body);
    setSourceName(file.name);
    if (!title.trim()) setTitle(fileTitle(file.name));
    invalidatePrepared();
  }

  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !sourceBody.trim() || connection?.status !== "ready") return;
    const input = draftInput();
    setPreparing(true);
    setPrepareError(null);
    try {
      setPrepared(await client.prepare(input));
    } catch (error: unknown) {
      setPrepareError(error instanceof Error ? error.message : "게시 검토를 준비하지 못했습니다.");
    } finally {
      setPreparing(false);
    }
  }

  function changeSource(event: ChangeEvent<HTMLTextAreaElement>) {
    setSourceBody(event.target.value);
    setSourceName(null);
    invalidatePrepared();
  }

  async function requestPublish() {
    if (!prepared || fixtureMode || publishing) return;
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    setPublishProgress("requesting_approval");
    try {
      const approval = await client.requestPublish(
        {
          draft: draftInput(),
          draftHash: prepared.draftHash,
          visibility,
          ...(coverFile ? { representativeImage: coverFile } : {}),
        },
        setPublishProgress,
      );
      setPublishApproval(approval);
    } catch (error: unknown) {
      setPublishError(
        error instanceof Error ? error.message : "게시 승인 요청을 만들지 못했습니다.",
      );
    } finally {
      setPublishProgress(null);
      setPublishing(false);
    }
  }

  async function approvePublish() {
    if (!publishApproval || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await client.approvePublish(publishApproval);
      setPublishResult(result);
      setPublishApproval(null);
    } catch (error: unknown) {
      setPublishError(
        error instanceof Error ? error.message : "Tistory 게시를 완료하지 못했습니다.",
      );
    } finally {
      setPublishing(false);
    }
  }

  async function cancelPublish() {
    if (!publishApproval || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      await client.cancelPublish(publishApproval);
      setPublishApproval(null);
    } catch (error: unknown) {
      setPublishError(error instanceof Error ? error.message : "게시 요청을 취소하지 못했습니다.");
    } finally {
      setPublishing(false);
    }
  }

  const ready = connection?.status === "ready";
  const canPrepare = ready && title.trim().length > 0 && sourceBody.trim().length > 0 && !preparing;
  const workflowLocked = Boolean(publishApproval) || publishing;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <aside className="sidebar" aria-label="주 탐색">
        <div className="brand-lockup">
          <span className="brand-mark">P</span>
          <div>
            <strong>Publication</strong>
            <small>Publish once, deliver clearly</small>
          </div>
        </div>
        <nav className="nav-list">
          {navigation.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`nav-item${activeView === item.id ? " active" : ""}`}
              aria-current={activeView === item.id ? "page" : undefined}
              onClick={() => setActiveView(item.id)}
            >
              <Icon name={item.icon} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span>HITL</span>
          <p>게시·수정·삭제는 실행 전에 사용자의 승인을 기다립니다.</p>
        </div>
        <div className="account-chip">
          <span className="avatar">J</span>
          <span>
            <strong>{accountLabel}</strong>
            <small>{fixtureMode ? "개발 미리보기" : "Identity 로그인"}</small>
          </span>
          {!fixtureMode && accountSettingsUrl ? (
            <a href={accountSettingsUrl} aria-label="Imprun 계정 관리">
              관리
            </a>
          ) : null}
          {!fixtureMode && onSignOut ? (
            <button type="button" onClick={onSignOut}>
              로그아웃
            </button>
          ) : null}
          {!fixtureMode && onChangeCloudTarget ? (
            <button type="button" onClick={onChangeCloudTarget}>
              Cloud 변경
            </button>
          ) : null}
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <span className="mobile-brand">Publication</span>
          <div className="topbar-status">
            {fixtureMode ? <span className="mode-badge">개발 미리보기</span> : null}
            <span className={`status-dot${ready ? " ready" : ""}`} />
            {loading ? "연결 확인 중" : ready ? "Tistory 준비됨" : "연결 필요"}
          </div>
        </header>

        <main id="main-content" className="main-content" tabIndex={-1}>
          {activeView === "connections" ? (
            <>
              <header className="page-header">
                <div>
                  <span className="eyebrow">연결</span>
                  <h1>게시 플랫폼을 연결합니다.</h1>
                  <p>로그인한 Imprun 계정에 연결된 플랫폼과 세션 상태를 관리하세요.</p>
                </div>
              </header>

              {loadError ? (
                <div className="notice error" role="alert">
                  {loadError}
                </div>
              ) : null}

              <section
                className="panel connections-panel"
                aria-labelledby="tistory-connection-title"
              >
                <div className="connection-overview">
                  <div className="platform-mark">T</div>
                  <div>
                    <span>게시 플랫폼</span>
                    <h2 id="tistory-connection-title">Tistory</h2>
                    <p>
                      {loading
                        ? "연결 상태를 확인하고 있습니다."
                        : ready
                          ? `${connection.blogHost} 블로그에 연결되어 있습니다.`
                          : connection?.status === "expired"
                            ? "저장된 세션이 만료되었습니다. 다시 연결해 주세요."
                            : "아직 연결된 Tistory 계정이 없습니다."}
                    </p>
                  </div>
                  <span className={`connection-badge ${ready ? "ready" : ""}`}>
                    {loading
                      ? "확인 중"
                      : ready
                        ? "연결됨"
                        : connection?.status === "expired"
                          ? "만료됨"
                          : "연결 안 됨"}
                  </span>
                </div>

                {ready && !showConnectionForm ? (
                  <div className="connection-actions">
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => setShowConnectionForm(true)}
                    >
                      다시 연결
                    </button>
                    <button
                      type="button"
                      className="danger-action"
                      onClick={() => setConfirmDisconnect(true)}
                    >
                      연결 해제
                    </button>
                  </div>
                ) : null}

                {confirmDisconnect ? (
                  <div className="disconnect-confirm" role="alert">
                    <div>
                      <strong>Tistory 연결을 해제할까요?</strong>
                      <p>저장된 카카오 로그인 정보와 Tistory 세션을 이 계정에서 비웁니다.</p>
                    </div>
                    <button
                      type="button"
                      className="danger-action"
                      disabled={disconnecting}
                      onClick={() => void disconnect()}
                    >
                      {disconnecting ? "해제 중…" : "연결 해제"}
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={disconnecting}
                      onClick={() => setConfirmDisconnect(false)}
                    >
                      취소
                    </button>
                  </div>
                ) : null}

                {!loading && (!ready || showConnectionForm) ? (
                  <form className="connection-form" onSubmit={connect}>
                    <div className="connection-security-note">
                      <strong>사용자 전용 보안 저장소</strong>
                      <p>
                        카카오 계정은 로그인 처리 후 비우고, Tistory 세션만 현재 Identity 사용자에게
                        매핑된 암호화 Secret Variable에 저장합니다. 게시 입력과 실행 결과에는
                        포함하지 않습니다.
                      </p>
                    </div>
                    <label className="field">
                      <span>
                        <strong>블로그 주소</strong>
                      </span>
                      <input
                        value={blogHost}
                        disabled={connecting}
                        onChange={(event) => setBlogHost(event.target.value)}
                        placeholder="example.tistory.com"
                        autoCapitalize="none"
                        autoCorrect="off"
                        required
                      />
                    </label>
                    <label className="field">
                      <span>
                        <strong>카카오계정</strong>
                      </span>
                      <input
                        value={accountId}
                        disabled={connecting}
                        onChange={(event) => setAccountId(event.target.value)}
                        type="email"
                        autoComplete="username"
                        placeholder="카카오계정 이메일"
                        required
                      />
                    </label>
                    <label className="field">
                      <span>
                        <strong>비밀번호</strong>
                      </span>
                      <input
                        value={password}
                        disabled={connecting}
                        onChange={(event) => setPassword(event.target.value)}
                        type="password"
                        autoComplete="current-password"
                        placeholder="카카오계정 비밀번호"
                        required
                      />
                    </label>
                    <div className="connection-actions">
                      <button
                        type="submit"
                        className="primary-action"
                        disabled={connecting || !blogHost.trim() || !accountId.trim() || !password}
                      >
                        {connecting ? "연결 중…" : "카카오로 Tistory 연결"}
                      </button>
                      {ready ? (
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={connecting}
                          onClick={() => setShowConnectionForm(false)}
                        >
                          취소
                        </button>
                      ) : null}
                    </div>
                  </form>
                ) : null}
                {connectionProgress ? (
                  <div className="notice fixture" role="status">
                    {connectionProgressLabels[connectionProgress]}
                  </div>
                ) : null}
                {connectionError ? (
                  <div className="notice error" role="alert">
                    {connectionError}
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <>
              <header className="page-header">
                <div>
                  <span className="eyebrow">새 게시</span>
                  <h1>문서를 게시합니다.</h1>
                  <p>원문을 선택하고 게시 옵션을 확인한 뒤, 승인 요청을 만드세요.</p>
                </div>
                <nav className="step-summary" aria-label="게시 단계">
                  <span className="done">1</span>
                  <small>문서</small>
                  <i />
                  <span className={prepared ? "done" : "current"}>2</span>
                  <small>검토</small>
                  <i />
                  <span>3</span>
                  <small>승인</small>
                </nav>
              </header>

              {loadError ? (
                <div className="notice error" role="alert">
                  {loadError}
                </div>
              ) : null}
              {fixtureMode ? (
                <div className="notice fixture" role="status">
                  Fixture에서는 화면과 검토 상태만 확인하며 실제 게시 요청은 보내지 않습니다.
                </div>
              ) : null}

              {!loading && !ready ? (
                <section
                  className="panel connection-required"
                  aria-labelledby="connection-required-title"
                >
                  <div>
                    <span className="eyebrow">연결 필요</span>
                    <h2 id="connection-required-title">먼저 Tistory 계정을 연결하세요.</h2>
                    <p>카카오계정 입력과 세션 관리는 새 게시가 아니라 연결 메뉴에서 수행합니다.</p>
                  </div>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => setActiveView("connections")}
                  >
                    연결 메뉴로 이동
                  </button>
                </section>
              ) : null}

              <form className="studio-grid" onSubmit={prepare}>
                <div className="editor-column">
                  <section className="panel source-panel">
                    <div className="section-heading">
                      <div>
                        <span className="section-number">01</span>
                        <h2>원문</h2>
                      </div>
                      <fieldset className="format-switch">
                        <legend className="sr-only">원문 형식</legend>
                        {(["markdown", "html"] as const).map((format) => (
                          <button
                            key={format}
                            type="button"
                            className={sourceFormat === format ? "active" : ""}
                            aria-pressed={sourceFormat === format}
                            disabled={workflowLocked}
                            onClick={() => {
                              setSourceFormat(format);
                              invalidatePrepared();
                            }}
                          >
                            {format === "markdown" ? "Markdown" : "HTML"}
                          </button>
                        ))}
                      </fieldset>
                    </div>

                    <label className="drop-zone">
                      <input
                        ref={fileInputRef}
                        className="sr-only"
                        type="file"
                        disabled={workflowLocked}
                        accept=".md,.markdown,.html,.htm,text/markdown,text/html"
                        onChange={(event) => void chooseSource(event.target.files?.[0] ?? null)}
                      />
                      <span className="drop-icon">
                        <Icon name={sourceName ? "check" : "upload"} aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{sourceName ?? "MD 또는 HTML 파일 선택"}</strong>
                        <small>
                          {sourceName ? "파일을 다시 선택할 수 있습니다." : "최대 2MB · 로컬 파일"}
                        </small>
                      </span>
                    </label>
                    {sourceError ? (
                      <p className="field-error" role="alert">
                        {sourceError}
                      </p>
                    ) : null}

                    <label className="field source-field" htmlFor={sourceInputId}>
                      <span>
                        <strong>원문 내용</strong>
                        <small>파일 대신 직접 붙여넣을 수도 있습니다.</small>
                      </span>
                      <textarea
                        id={sourceInputId}
                        value={sourceBody}
                        disabled={workflowLocked}
                        onChange={changeSource}
                        spellCheck={false}
                        placeholder={
                          sourceFormat === "markdown"
                            ? "# 제목\n\n게시할 Markdown을 입력하세요."
                            : "<h1>제목</h1>\n<p>게시할 HTML을 입력하세요.</p>"
                        }
                      />
                    </label>
                  </section>

                  <section className="panel options-panel">
                    <div className="section-heading">
                      <div>
                        <span className="section-number">02</span>
                        <h2>게시 정보</h2>
                      </div>
                    </div>
                    <div className="form-grid">
                      <label className="field wide">
                        <span>
                          <strong>제목</strong>
                        </span>
                        <input
                          value={title}
                          disabled={workflowLocked}
                          maxLength={250}
                          onChange={(event) => {
                            setTitle(event.target.value);
                            invalidatePrepared();
                          }}
                          placeholder="게시물 제목"
                        />
                      </label>
                      <label className="field">
                        <span>
                          <strong>카테고리</strong>
                        </span>
                        <select
                          value={categoryId}
                          disabled={workflowLocked}
                          onChange={(event) => {
                            setCategoryId(Number(event.target.value));
                            invalidatePrepared();
                          }}
                        >
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>
                          <strong>태그</strong>
                          <small>쉼표로 구분</small>
                        </span>
                        <input
                          value={tags}
                          disabled={workflowLocked}
                          onChange={(event) => {
                            setTags(event.target.value);
                            invalidatePrepared();
                          }}
                          placeholder="개발, 기록"
                        />
                      </label>
                      <fieldset className="field wide visibility-field">
                        <legend>
                          <strong>공개 범위</strong>
                        </legend>
                        <div className="visibility-options">
                          {(["private", "public"] as const).map((value) => (
                            <label key={value} className={visibility === value ? "selected" : ""}>
                              <input
                                type="radio"
                                name="visibility"
                                value={value}
                                checked={visibility === value}
                                disabled={workflowLocked}
                                onChange={() => setVisibility(value)}
                              />
                              <span>
                                <strong>{value === "private" ? "비공개" : "공개"}</strong>
                                <small>
                                  {value === "private"
                                    ? "나만 확인할 수 있습니다."
                                    : "승인 즉시 독자에게 공개됩니다."}
                                </small>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <label className="field wide">
                        <span>
                          <strong>대표 이미지</strong>
                          <small>선택</small>
                        </span>
                        <span className="file-control">
                          <input
                            className="sr-only"
                            type="file"
                            disabled={workflowLocked}
                            accept="image/png,image/jpeg,image/gif,image/webp"
                            onChange={(event) => {
                              const file = event.target.files?.[0] ?? null;
                              setCoverFile(file);
                              setCoverName(file?.name ?? null);
                            }}
                          />
                          <span>{coverName ?? "PNG, JPG, GIF, WebP"}</span>
                          <b>{coverName ? "변경" : "선택"}</b>
                        </span>
                      </label>
                    </div>
                  </section>
                </div>

                <aside className="review-column">
                  <section className="panel connection-card">
                    <div className="platform-mark">T</div>
                    <div>
                      <span>게시 연결</span>
                      {ready ? (
                        <label className="connection-select">
                          <span className="sr-only">게시할 Tistory 연결</span>
                          <select
                            defaultValue="default"
                            aria-label="게시할 Tistory 연결"
                            disabled={workflowLocked}
                          >
                            <option value="default">Tistory · {connection.blogHost}</option>
                          </select>
                        </label>
                      ) : (
                        <button
                          type="button"
                          className="text-action"
                          onClick={() => setActiveView("connections")}
                        >
                          연결 메뉴에서 Tistory 추가
                        </button>
                      )}
                    </div>
                    <span className={`connection-badge ${ready ? "ready" : ""}`}>
                      {ready ? "준비됨" : "연결 필요"}
                    </span>
                  </section>

                  <section className="panel review-card">
                    <div className="section-heading">
                      <div>
                        <span className="section-number">03</span>
                        <h2>게시 검토</h2>
                      </div>
                    </div>
                    {prepared ? (
                      <div className="prepared-view">
                        <div className="preview-frame">
                          <iframe
                            title="정화된 게시 미리보기"
                            sandbox=""
                            srcDoc={previewDocument(prepared.renderedHtml)}
                          />
                        </div>
                        <dl className="review-list">
                          <div>
                            <dt>형식</dt>
                            <dd>{prepared.content.format === "markdown" ? "Markdown" : "HTML"}</dd>
                          </div>
                          <div>
                            <dt>공개</dt>
                            <dd>{visibility === "private" ? "비공개" : "공개"}</dd>
                          </div>
                          <div>
                            <dt>태그</dt>
                            <dd>{prepared.tags.length || "없음"}</dd>
                          </div>
                          <div>
                            <dt>대표 이미지</dt>
                            <dd>{coverName ?? "없음"}</dd>
                          </div>
                        </dl>
                        <div className="hash-row">
                          <span>승인 기준</span>
                          <code>{prepared.draftHash.slice(0, 20)}…</code>
                        </div>
                      </div>
                    ) : (
                      <div className="empty-review">
                        <span className="empty-mark">P</span>
                        <strong>아직 검토할 문서가 없습니다.</strong>
                        <p>원문과 제목을 입력한 뒤 게시 검토를 준비하세요.</p>
                      </div>
                    )}
                    {prepareError ? (
                      <div className="notice error" role="alert">
                        {prepareError}
                      </div>
                    ) : null}
                    <button
                      type="submit"
                      className="primary-action"
                      disabled={!canPrepare || workflowLocked}
                    >
                      {preparing ? "검토 준비 중…" : prepared ? "변경 사항 다시 검토" : "게시 검토"}
                    </button>
                    {publishProgress ? (
                      <div className="notice fixture" role="status">
                        {publishProgressLabels[publishProgress]}
                      </div>
                    ) : null}
                    {publishApproval ? (
                      <div className="approval-panel" role="status">
                        <div>
                          <strong>게시 승인을 기다리고 있습니다.</strong>
                          <small>
                            {publishApproval.title} ·{" "}
                            {new Date(publishApproval.expiresAt).toLocaleString()}
                            까지
                          </small>
                        </div>
                        <button
                          type="button"
                          className="approval-action"
                          disabled={publishing}
                          onClick={() => void approvePublish()}
                        >
                          {publishing ? "게시 중…" : "내용을 확인했고 게시합니다"}
                        </button>
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={publishing}
                          onClick={() => void cancelPublish()}
                        >
                          취소
                        </button>
                      </div>
                    ) : publishResult ? (
                      <div className="publish-success" role="status">
                        <span className="empty-mark">✓</span>
                        <strong>Tistory 게시가 완료되었습니다.</strong>
                        <a href={publishResult.entryUrl} target="_blank" rel="noreferrer">
                          게시물 열기
                        </a>
                        <small>
                          {publishResult.visibility === "private" ? "비공개" : "공개"} · 게시물 ID{" "}
                          {publishResult.postId}
                        </small>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="approval-action"
                        disabled={!prepared || fixtureMode || publishing}
                        onClick={() => void requestPublish()}
                      >
                        {fixtureMode
                          ? "Cloud 연결 후 승인 요청"
                          : publishing
                            ? "승인 요청 준비 중…"
                            : `${visibility === "private" ? "비공개" : "공개"} 게시 승인 요청`}
                      </button>
                    )}
                    {publishError ? (
                      <div className="notice error" role="alert">
                        {publishError}
                      </div>
                    ) : null}
                    <p className="approval-note">승인 전에는 Tistory 게시물을 만들지 않습니다.</p>
                  </section>
                </aside>
              </form>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
