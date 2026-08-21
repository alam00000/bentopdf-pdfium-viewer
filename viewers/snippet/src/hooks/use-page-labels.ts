import { useEffect, useRef, useState } from 'preact/hooks';
import { useRegistry, useDocumentState } from '@embedpdf/core/preact';

export function usePageLabels(documentId: string | null | undefined): {
  labels: string[];
  labelFor: (pageOneBased: number) => string;
} {
  const [labels, setLabels] = useState<string[]>([]);
  const { registry } = useRegistry();
  const documentState = useDocumentState(documentId ?? null);
  const doc = documentState?.document;
  const pageCount = doc?.pageCount ?? 0;

  const fetchedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!documentId || !doc || !registry) {
      setLabels([]);
      fetchedKeyRef.current = null;
      return;
    }
    const key = `${documentId}:${pageCount}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;

    let cancelled = false;
    const engine = registry.getEngine();
    if (typeof engine?.getPageLabels !== 'function') {
      setLabels([]);
      return;
    }
    engine.getPageLabels(doc).wait(
      (result) => {
        if (!cancelled) setLabels(Array.isArray(result) ? result : []);
      },
      () => {
        if (!cancelled) setLabels([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [registry, documentId, doc, pageCount]);

  const labelFor = (pageOneBased: number): string => {
    const label = labels[pageOneBased - 1];
    return label && label.length > 0 ? label : String(pageOneBased);
  };

  return { labels, labelFor };
}
