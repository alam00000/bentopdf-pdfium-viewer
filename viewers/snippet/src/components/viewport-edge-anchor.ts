import { useCallback, useRef } from 'preact/hooks';

const VIEWPORT_SELECTOR = '[data-epdf-viewport-host]';

interface EdgeAnchor {
  getBoundingClientRect(): DOMRect;
  contextElement: Element;
}

export function useViewportEdgeAnchor(
  edge: 'top' | 'bottom',
): (from: Element) => EdgeAnchor | null {
  const cached = useRef<EdgeAnchor | null>(null);
  return useCallback(
    (from: Element) => {
      const root = from.getRootNode();
      const scope =
        root instanceof ShadowRoot || root instanceof Document ? root : from.ownerDocument;
      const host =
        scope.querySelector(VIEWPORT_SELECTOR) ?? scope.querySelector('#document-content');
      if (!host) return null;
      if (cached.current?.contextElement !== host) {
        cached.current = {
          contextElement: host,
          getBoundingClientRect: () => {
            const r = host.getBoundingClientRect();
            return new DOMRect(r.left, edge === 'top' ? r.top : r.bottom, r.width, 0);
          },
        };
      }
      return cached.current;
    },
    [edge],
  );
}
