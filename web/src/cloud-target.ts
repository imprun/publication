export interface CloudTarget {
  baseUrl: string;
  workspace: string;
}

const STORAGE_KEY = "publication.cloudTarget.v1";
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

export function normalizeCloudTarget(
  baseUrlInput: string,
  workspaceInput: string,
  pageOrigin = window.location.origin,
): CloudTarget {
  const workspace = workspaceInput.trim();
  if (!WORKSPACE_PATTERN.test(workspace)) {
    throw new Error("워크스페이스 이름을 확인해 주세요.");
  }

  let url: URL;
  try {
    url = new URL(baseUrlInput.trim());
  } catch {
    throw new Error("올바른 Imprun Cloud 주소를 입력해 주세요.");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Cloud 주소는 경로 없이 https://...cloud.imprun.dev 형식으로 입력해 주세요.");
  }

  const page = new URL(pageOrigin);
  const productionHost =
    url.protocol === "https:" &&
    url.hostname.endsWith(".cloud.imprun.dev") &&
    url.hostname !== "cloud.imprun.dev" &&
    !url.port;
  const localDevelopment =
    isLoopback(page.hostname) &&
    isLoopback(url.hostname) &&
    (url.protocol === "http:" || url.protocol === "https:");
  if (!productionHost && !localDevelopment) {
    throw new Error("Imprun Cloud의 HTTPS 주소만 연결할 수 있습니다.");
  }

  return { baseUrl: url.origin, workspace };
}

export function loadCloudTarget(storage: Storage = window.localStorage): CloudTarget | null {
  try {
    const value = storage.getItem(STORAGE_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<CloudTarget>;
    if (typeof parsed.baseUrl !== "string" || typeof parsed.workspace !== "string") return null;
    return normalizeCloudTarget(parsed.baseUrl, parsed.workspace);
  } catch {
    return null;
  }
}

export function saveCloudTarget(target: CloudTarget, storage: Storage = window.localStorage): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(target));
}

export function clearCloudTarget(storage: Storage = window.localStorage): void {
  storage.removeItem(STORAGE_KEY);
}
