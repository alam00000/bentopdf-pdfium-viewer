import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { fadeInViewerSurface, SURFACE_FADE_MS } from '@/lib/surface-fade';
import { useOrganizeContext } from './OrganizeContext';
import { OrganizePanel } from './OrganizePanel';

export function OrganizePanelGate({ documentId }: { documentId: string }) {
  const { isOrganizeMode } = useOrganizeContext();
  const [settled, setSettled] = useState(false);
  const wasOpenRef = useRef(isOrganizeMode);
  const markerRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOrganizeMode;
    const root = markerRef.current?.getRootNode();
    if (wasOpen && !isOrganizeMode && (root instanceof ShadowRoot || root instanceof Document)) {
      fadeInViewerSurface(root);
    }
  }, [isOrganizeMode]);

  useEffect(() => {
    if (!isOrganizeMode) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), SURFACE_FADE_MS);
    return () => clearTimeout(timer);
  }, [isOrganizeMode]);

  if (!isOrganizeMode) return <span ref={markerRef} hidden />;
  return <OrganizePanel documentId={documentId} entering={!settled} />;
}
