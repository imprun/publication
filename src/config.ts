export const DEFAULT_CONNECTION_ID = "default";
export const TISTORY_SESSION_PATH = "connections/tistory/default/session";
export const TISTORY_ACCOUNT_ID_PATH = "connections/tistory/default/account-id";
export const TISTORY_PASSWORD_PATH = "connections/tistory/default/password";
export const TISTORY_PROFILE_PATH = "connections/tistory/default/profile";
export const TISTORY_CONNECTION_RESOURCE_TYPE = "publication.connection@1";
export const TISTORY_SESSION_REFERENCE = `actor-variable:${TISTORY_SESSION_PATH}`;

export const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
