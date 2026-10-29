import { h } from 'preact';

import { buildScaleRatio } from '../measurement/formatter';
import { useScaleStore } from '../measurement/scale-store';
import { Button } from '../measurement/ui/controls';

interface Props {
  documentId: string;
}

export const MEASUREMENT_OPEN_SCALE_EVENT = 'bentopdf:open-measurement-scale-modal';

export function dispatchOpenScaleModal() {
  window.dispatchEvent(new CustomEvent(MEASUREMENT_OPEN_SCALE_EVENT));
}

export function MeasurementScaleBadge({ documentId }: Props) {
  const { activePreset } = useScaleStore(documentId);
  const ratio = buildScaleRatio(activePreset);
  const label = activePreset.name ? `${activePreset.name}: ${ratio}` : ratio;

  return (
    <div class="bg-bg-elevated mb-1 flex items-center justify-between gap-2 rounded-md px-3 py-2.5 text-sm">
      <div class="min-w-0 flex-1">
        <div class="text-fg-muted mb-0.5 text-xs tracking-[0.04em] uppercase">Scale</div>
        <div class="text-fg-primary truncate font-medium" dir="auto" title={label}>
          {label}
        </div>
      </div>
      <div class="shrink-0 px-2 py-1">
        <Button variant="link" size="sm" onClick={dispatchOpenScaleModal}>
          Set Scale…
        </Button>
      </div>
    </div>
  );
}
