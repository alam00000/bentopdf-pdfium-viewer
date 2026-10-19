const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function toSafeExternalUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

export function openExternalUri(uri: string): void {
  const href = toSafeExternalUri(uri);
  if (href) window.open(href, '_blank', 'noopener,noreferrer');
}
