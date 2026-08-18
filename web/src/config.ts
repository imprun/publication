export type PublicConfig =
  | { mode: "fixture" }
  | {
      mode: "cloud";
      cloudBaseUrl?: string;
      workspace?: string;
      identityAuthority: string;
      identityClientId: string;
      identityAudience: string;
      identityScope: string;
    }
  | { mode: "invalid"; message: string };

interface RuntimeConfig {
  mode?: string;
  cloudBaseUrl?: string;
  workspace?: string;
  identityAuthority?: string;
  identityClientId?: string;
  identityAudience?: string;
  identityScope?: string;
}

declare global {
  interface Window {
    __PUBLICATION_CONFIG__?: RuntimeConfig;
  }
}

function required(name: string, value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} 환경 변수가 설정되지 않았습니다.`);
  return normalized;
}

export function readPublicConfig(): PublicConfig {
  const runtime = window.__PUBLICATION_CONFIG__;
  const mode = runtime?.mode || import.meta.env.VITE_PUBLICATION_API_MODE;
  if (mode === "fixture") return { mode };
  if (mode === "cloud") {
    try {
      const cloudBaseUrl =
        runtime?.cloudBaseUrl?.trim() || import.meta.env.VITE_PUBLICATION_CLOUD_BASE_URL?.trim();
      const workspace =
        runtime?.workspace?.trim() || import.meta.env.VITE_PUBLICATION_CLOUD_WORKSPACE?.trim();
      return {
        mode,
        ...(cloudBaseUrl ? { cloudBaseUrl: cloudBaseUrl.replace(/\/$/, "") } : {}),
        ...(workspace ? { workspace } : {}),
        identityAuthority: required(
          "VITE_IMPRUN_IDENTITY_AUTHORITY",
          runtime?.identityAuthority || import.meta.env.VITE_IMPRUN_IDENTITY_AUTHORITY,
        ).replace(/\/$/, ""),
        identityClientId: required(
          "VITE_IMPRUN_IDENTITY_CLIENT_ID",
          runtime?.identityClientId || import.meta.env.VITE_IMPRUN_IDENTITY_CLIENT_ID,
        ),
        identityAudience: required(
          "VITE_IMPRUN_IDENTITY_AUDIENCE",
          runtime?.identityAudience || import.meta.env.VITE_IMPRUN_IDENTITY_AUDIENCE,
        ),
        identityScope:
          runtime?.identityScope?.trim() ||
          import.meta.env.VITE_IMPRUN_IDENTITY_SCOPE?.trim() ||
          "openid profile email offline_access",
      };
    } catch (error) {
      return {
        mode: "invalid",
        message: error instanceof Error ? error.message : "Cloud 연결 설정이 올바르지 않습니다.",
      };
    }
  }
  return {
    mode: "invalid",
    message: "Publication API mode가 설정되지 않았습니다.",
  };
}
