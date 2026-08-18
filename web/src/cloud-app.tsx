import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { App } from "./app";
import { useAuth } from "./auth/auth-context";
import { CloudPublicationClient } from "./cloud-client";
import {
  type CloudTarget,
  clearCloudTarget,
  loadCloudTarget,
  normalizeCloudTarget,
  saveCloudTarget,
} from "./cloud-target";
import type { PublicConfig } from "./config";

function AuthCallback() {
  const auth = useAuth();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void auth.completeSignIn();
  }, [auth]);
  return (
    <main className="configuration-page">
      <div className="configuration-card" role="status">
        <span className="brand-mark">P</span>
        <h1>로그인을 완료하고 있습니다.</h1>
        <p>Identity 응답과 Publication 권한을 확인하고 있습니다.</p>
      </div>
    </main>
  );
}

function SignInPage({ message }: { message?: string | null }) {
  const auth = useAuth();
  return (
    <main className="configuration-page sign-in-page">
      <div className="configuration-card">
        <span className="brand-mark">P</span>
        <span className="eyebrow">Publication</span>
        <h1>내 문서를 원하는 곳에 게시하세요.</h1>
        <p>Markdown과 HTML을 검토하고, 명시적으로 승인한 내용만 연결된 플랫폼에 게시합니다.</p>
        {message ? (
          <div className="notice error" role="alert">
            {message}
          </div>
        ) : null}
        <button type="button" className="primary-action" onClick={() => void auth.signIn()}>
          Imprun으로 로그인
        </button>
        <small>비밀번호와 계정 보안은 Imprun Identity에서 관리합니다.</small>
      </div>
    </main>
  );
}

function configuredTarget(config: Extract<PublicConfig, { mode: "cloud" }>): CloudTarget | null {
  if (!config.cloudBaseUrl || !config.workspace) return null;
  try {
    return normalizeCloudTarget(config.cloudBaseUrl, config.workspace);
  } catch {
    return null;
  }
}

function CloudTargetPage({
  initialTarget,
  onSelect,
  onSignOut,
}: {
  initialTarget: CloudTarget | null;
  onSelect: (target: CloudTarget) => void;
  onSignOut: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initialTarget?.baseUrl ?? "");
  const [workspace, setWorkspace] = useState(initialTarget?.workspace ?? "");
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const target = normalizeCloudTarget(baseUrl, workspace);
      saveCloudTarget(target);
      setError(null);
      onSelect(target);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Cloud 연결 정보를 확인해 주세요.");
    }
  }

  return (
    <main className="configuration-page cloud-target-page">
      <form className="configuration-card cloud-target-card" onSubmit={submit}>
        <span className="brand-mark">P</span>
        <span className="eyebrow">Publication Cloud</span>
        <h1>게시 작업을 실행할 Cloud를 연결하세요.</h1>
        <p>내 Imprun Cloud의 주소와 Publication 앱이 등록된 워크스페이스를 입력합니다.</p>
        {error ? (
          <div className="notice error" role="alert">
            {error}
          </div>
        ) : null}
        <label htmlFor="cloud-base-url">Cloud 주소</label>
        <input
          id="cloud-base-url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://example.cloud.imprun.dev"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
        />
        <label htmlFor="cloud-workspace">워크스페이스</label>
        <input
          id="cloud-workspace"
          type="text"
          autoComplete="off"
          placeholder="my-workspace"
          value={workspace}
          onChange={(event) => setWorkspace(event.target.value)}
          required
        />
        <button type="submit" className="primary-action">
          Cloud 연결
        </button>
        <button type="button" className="secondary-action" onClick={onSignOut}>
          다른 Imprun 계정 사용
        </button>
        <small>주소와 워크스페이스만 이 브라우저에 저장하며 인증 토큰은 저장하지 않습니다.</small>
      </form>
    </main>
  );
}

export function CloudApplication({ config }: { config: Extract<PublicConfig, { mode: "cloud" }> }) {
  const auth = useAuth();
  const defaultTarget = useMemo(() => configuredTarget(config), [config]);
  const [target, setTarget] = useState<CloudTarget | null>(
    () => defaultTarget ?? loadCloudTarget(),
  );
  const client = useMemo(
    () =>
      target
        ? new CloudPublicationClient({
            baseUrl: target.baseUrl,
            workspace: target.workspace,
            accessToken: () => auth.user?.access_token,
            onUnauthorized: auth.invalidateSession,
          })
        : null,
    [auth.invalidateSession, auth.user?.access_token, target],
  );

  if (window.location.pathname === "/auth/callback") return <AuthCallback />;
  if (auth.status === "loading") {
    return (
      <main className="configuration-page">
        <div className="configuration-card" role="status">
          <span className="brand-mark">P</span>
          <h1>로그인 상태를 확인하고 있습니다.</h1>
        </div>
      </main>
    );
  }
  if (auth.status !== "authenticated" || !auth.user) {
    return <SignInPage message={auth.error} />;
  }
  if (!target || !client) {
    return (
      <CloudTargetPage
        initialTarget={defaultTarget}
        onSelect={setTarget}
        onSignOut={() => void auth.signOut()}
      />
    );
  }

  const label =
    (typeof auth.user.profile.name === "string" && auth.user.profile.name) ||
    (typeof auth.user.profile.email === "string" && auth.user.profile.email) ||
    "Imprun 계정";
  const accountSettingsUrl = `${config.identityAuthority}/settings?source=${encodeURIComponent(config.identityClientId)}`;
  return (
    <App
      client={client}
      fixtureMode={false}
      accountLabel={label}
      accountSettingsUrl={accountSettingsUrl}
      onSignOut={() => void auth.signOut()}
      onChangeCloudTarget={() => {
        clearCloudTarget();
        setTarget(null);
      }}
    />
  );
}
