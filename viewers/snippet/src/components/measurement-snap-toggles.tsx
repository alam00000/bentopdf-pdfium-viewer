import { h, Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { Tooltip } from './ui/tooltip';
import { getActiveMeasurementDoc } from '../measurement/scale-store';
import {
  type SnapKind,
  setLoupeEnabled,
  setSnapEnabled,
  setSnapKind,
  useSnapSettings,
} from '../measurement/snap-settings';
import { IconButton } from '../measurement/ui/controls';
import { Menu, PopupMenuItem, PopupMenuLabel } from '../measurement/ui/floating';
import {
  CircleIcon,
  MagnetIcon,
  MagnifyingGlassPlusIcon,
  SquareIcon,
  TriangleIcon,
  XIcon,
  type Icon,
} from '../measurement/ui/icons';

const SNAP_KINDS: {
  kind: SnapKind;
  label: string;
  Glyph: Icon;
  weight: 'fill' | 'bold';
}[] = [
  { kind: 'path', label: 'Paths', Glyph: SquareIcon, weight: 'fill' },
  { kind: 'endpoint', label: 'Endpoints', Glyph: CircleIcon, weight: 'fill' },
  { kind: 'midpoint', label: 'Midpoints', Glyph: TriangleIcon, weight: 'fill' },
  { kind: 'intersection', label: 'Intersections', Glyph: XIcon, weight: 'bold' },
];

export function MeasurementSnapToggles() {
  const docId = getActiveMeasurementDoc();
  const fallbackId = '__snap-toggles-no-doc__';
  const settings = useSnapSettings(docId ?? fallbackId);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  if (!docId) return null;

  return (
    <>
      <Tooltip content="Snap" position="bottom">
        <IconButton
          variant="toolbar"
          ref={triggerRef}
          onClick={() => setOpen((v) => !v)}
          active={settings.enabled}
          aria-label="Measurement snap settings"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MagnetIcon size={18} weight="regular" />
        </IconButton>
      </Tooltip>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        align="end"
        side="bottom"
      >
        <PopupMenuItem
          selected={settings.enabled}
          icon={<MagnetIcon size={14} weight="regular" />}
          onClick={() => setSnapEnabled(docId, !settings.enabled)}
          keepOpen
          label={settings.enabled ? 'Snap is On' : 'Snap is Off'}
        />
        <PopupMenuLabel>Snap to</PopupMenuLabel>
        {SNAP_KINDS.map(({ kind, label, Glyph, weight }) => (
          <PopupMenuItem
            key={kind}
            disabled={!settings.enabled}
            icon={<Glyph size={14} weight={weight} />}
            selected={!!settings[kind] && settings.enabled}
            onClick={() => setSnapKind(docId, kind, !settings[kind])}
            keepOpen
            label={label}
          />
        ))}
      </Menu>
    </>
  );
}

export function MeasurementLoupeToggle() {
  const docId = getActiveMeasurementDoc();
  const fallbackId = '__loupe-toggle-no-doc__';
  const settings = useSnapSettings(docId ?? fallbackId);
  if (!docId) return null;
  const on = settings.loupe;
  return (
    <Tooltip content="Magnifier" position="bottom">
      <IconButton
        variant="toolbar"
        onClick={() => setLoupeEnabled(docId, !on)}
        active={on}
        aria-label={on ? 'Hide magnifier' : 'Show magnifier'}
      >
        <MagnifyingGlassPlusIcon size={18} weight="regular" />
      </IconButton>
    </Tooltip>
  );
}
