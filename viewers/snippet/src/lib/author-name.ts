const STORAGE_KEY = 'embedpdf:annotation-author';

let cached: string | null = null;

export function getStoredAuthorName(): string {
  if (cached !== null) return cached;
  try {
    cached = window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    cached = '';
  }
  return cached;
}

export function setStoredAuthorName(name: string): void {
  cached = name;
  try {
    if (name) window.localStorage.setItem(STORAGE_KEY, name);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}
