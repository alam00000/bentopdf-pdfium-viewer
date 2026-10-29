import { useEffect, useState } from 'preact/hooks';

export type PagesClipboard = {
  tempDocId: string;
  count: number;
  bytes: Uint8Array;
  mode: 'cut' | 'copy';
  sameDoc?: {
    docId: string;
    indices: number[];
    structuralVersion: number;
  };
} | null;

let current: PagesClipboard = null;
const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {}
  }
}

export function getPagesClipboard(): PagesClipboard {
  return current;
}

export function setPagesClipboard(next: PagesClipboard) {
  current = next;
  emit();
}

export function clearPagesClipboard() {
  setPagesClipboard(null);
}

const pending = new Set<Promise<unknown>>();

export function trackPagesClipboardWrite<T>(write: Promise<T>): Promise<T> {
  const tracked = write.finally(() => {
    pending.delete(tracked);
    emit();
  });
  pending.add(tracked);
  emit();
  return tracked;
}

export function isPagesClipboardPending(): boolean {
  return pending.size > 0;
}

export async function settledPagesClipboard(): Promise<PagesClipboard> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  return current;
}

export function usePagesClipboard(): PagesClipboard {
  const [, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    subscribers.add(onChange);
    return () => {
      subscribers.delete(onChange);
    };
  }, []);
  return current;
}
