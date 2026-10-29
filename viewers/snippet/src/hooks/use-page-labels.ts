import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useRegistry, useDocumentState } from '@embedpdf/core/preact';

export const PAGE_LABELS_CHANGED_EVENT = 'bento:page-labels-changed';

export function usePageLabels(documentId: string | null | undefined): {
  labels: string[];
  labelFor: (pageOneBased: number) => string;
} {
  const [labels, setLabels] = useState<string[]>([]);
  const { registry } = useRegistry();
  const documentState = useDocumentState(documentId ?? null);
  const doc = documentState?.document;
  const pageCount = doc?.pageCount ?? 0;
  const [invalidationTick, setInvalidationTick] = useState(0);

  const fetchedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!documentId || !doc || !registry) {
      setLabels([]);
      fetchedKeyRef.current = null;
      return;
    }
    const key = `${documentId}:${pageCount}:${invalidationTick}`;
    if (fetchedKeyRef.current === key) return;

    let cancelled = false;
    const engine = registry.getEngine();
    if (typeof engine?.getPageLabels !== 'function') {
      setLabels([]);
      return;
    }
    engine.getPageLabels(doc).wait(
      (result) => {
        if (cancelled) return;
        fetchedKeyRef.current = key;
        setLabels(Array.isArray(result) ? result : []);
      },
      () => {
        if (!cancelled) setLabels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [registry, documentId, doc, pageCount, invalidationTick]);

  useEffect(() => {
    if (!documentId) return;
    const handler = (e: Event) => {
      const detail = e instanceof CustomEvent ? e.detail : undefined;
      const target =
        detail && typeof detail === 'object' && 'documentId' in detail
          ? detail.documentId
          : undefined;
      if (target == null || target === documentId) setInvalidationTick((n) => n + 1);
    };
    window.addEventListener(PAGE_LABELS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PAGE_LABELS_CHANGED_EVENT, handler);
  }, [documentId]);

  const labelFor = useCallback(
    (pageOneBased: number): string => {
      const label = labels[pageOneBased - 1];
      return label && label.length > 0 ? label : String(pageOneBased);
    },
    [labels],
  );

  return { labels, labelFor };
}
