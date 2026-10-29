import { useEffect, useState } from 'preact/hooks';

export interface MeasurePointer {
  documentId: string;
  pageIndex: number;
  x: number;
  y: number;
}

let current: MeasurePointer | null = null;
const listeners = new Set<() => void>();

export function setMeasurePointer(next: MeasurePointer | null): void {
  if (
    next === current ||
    (next &&
      current &&
      next.documentId === current.documentId &&
      next.pageIndex === current.pageIndex &&
      next.x === current.x &&
      next.y === current.y)
  ) {
    return;
  }
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

export function getMeasurePointer(): MeasurePointer | null {
  return current;
}

export function subscribeMeasurePointer(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useMeasurePointer(): MeasurePointer | null {
  const [p, setP] = useState(getMeasurePointer);
  useEffect(() => {
    setP(getMeasurePointer());
    return subscribeMeasurePointer(() => setP(getMeasurePointer()));
  }, []);
  return p;
}
