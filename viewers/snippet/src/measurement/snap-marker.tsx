import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { subscribeLoupe, type LoupeSnapshot } from './loupe-bus';
import type { SnapKind } from './snap-settings';
import { LOUPE_COLORS } from './colors';

interface Props {
  documentId: string;
  pageIndex: number;
}

const SNAP_COLOR = LOUPE_COLORS.snap;
const HALF = 6;

function Glyph({ kind }: { kind: SnapKind }) {
  const stroke = SNAP_COLOR;
  const fill = SNAP_COLOR;
  switch (kind) {
    case 'path':
      return <rect x={-HALF} y={-HALF} width={HALF * 2} height={HALF * 2} fill={fill} />;
    case 'endpoint':
      return <circle cx={0} cy={0} r={HALF} fill={fill} />;
    case 'midpoint':
      return <polygon points={`0,${-HALF} ${HALF},${HALF} ${-HALF},${HALF}`} fill={fill} />;
    case 'intersection':
      return (
        <g>
          <line
            x1={-HALF}
            y1={-HALF}
            x2={HALF}
            y2={HALF}
            stroke={stroke}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <line
            x1={-HALF}
            y1={HALF}
            x2={HALF}
            y2={-HALF}
            stroke={stroke}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </g>
      );
  }
}

export function MeasurementSnapMarker({ documentId, pageIndex }: Props) {
  const [snap, setSnap] = useState<LoupeSnapshot | null>(null);

  useEffect(() => {
    const unsub = subscribeLoupe((s) => {
      if (!s || s.documentId !== documentId || s.pageIndex !== pageIndex) {
        setSnap(null);
        return;
      }
      setSnap(s);
    });
    return unsub;
  }, [documentId, pageIndex]);

  if (!snap || !snap.snap) return null;
  const x = snap.snap.pageCssX;
  const y = snap.snap.pageCssY;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        transform: `translate(${x}px, ${y}px)`,
        pointerEvents: 'none',
        zIndex: 12,
      }}
    >
      <svg
        width={HALF * 2 + 8}
        height={HALF * 2 + 8}
        viewBox={`${-HALF - 4} ${-HALF - 4} ${HALF * 2 + 8} ${HALF * 2 + 8}`}
        style={{
          position: 'absolute',
          left: -(HALF + 4),
          top: -(HALF + 4),
          overflow: 'visible',
          filter: `drop-shadow(0 0 1.5px ${LOUPE_COLORS.markerHalo})`,
        }}
        aria-hidden
      >
        <Glyph kind={snap.snap.kind} />
      </svg>
    </div>
  );
}
