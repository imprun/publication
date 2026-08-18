import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import type { PublicConfig } from "../config";

export function safeLocalReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

export function createUserManager(config: Extract<PublicConfig, { mode: "cloud" }>): UserManager {
  return new UserManager({
    authority: config.identityAuthority,
    client_id: config.identityClientId,
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: `${window.location.origin}/sign-in`,
    response_type: "code",
    scope: config.identityScope,
    extraQueryParams: { audience: config.identityAudience },
    automaticSilentRenew: true,
    monitorSession: true,
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
}
