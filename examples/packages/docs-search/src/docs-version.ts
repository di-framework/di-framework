/** Canonical docs version keys: `latest` or `vMAJOR.MINOR`. */
export function normalizeDocsVersion(raw?: string | null, referer?: string | null): string {
  const fromToken = parseVersionToken(raw);
  if (fromToken) return fromToken;
  return parseVersionFromUrl(referer) ?? 'latest';
}

export function parseVersionToken(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  const token = raw.trim();
  if (!token || token === 'd' || token === 'Writerside' || token === 'docs') return undefined;
  if (token === 'latest' || token === 'current' || token === '/') return 'latest';
  const minor = token.match(/^v?(\d+)\.(\d+)/i);
  if (minor) return `v${minor[1]}.${minor[2]}`;
  return undefined;
}

export function parseVersionFromUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    const tagged = path.match(/\/(v\d+\.\d+)(?:\/|$)/i);
    if (tagged) return parseVersionToken(tagged[1]);
    if (/\/latest(?:\/|$)/i.test(path)) return 'latest';
  } catch {
    const tagged = url.match(/\/(v\d+\.\d+)(?:\/|$)/i);
    if (tagged) return parseVersionToken(tagged[1]);
  }
  return undefined;
}
