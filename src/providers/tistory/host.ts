export function normalizeTistoryHost(value: string): string {
  const withoutProtocol = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const host = withoutProtocol.split("/")[0]?.replace(/\.$/, "") ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.tistory\.com$/.test(host)) {
    throw new Error("blogHost must be a direct *.tistory.com host");
  }
  return host;
}

export function tistoryOrigin(host: string): string {
  return `https://${normalizeTistoryHost(host)}`;
}
