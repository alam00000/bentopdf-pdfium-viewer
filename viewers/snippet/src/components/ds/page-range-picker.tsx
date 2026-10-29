import { h } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';

import { NumberField, Radio } from './controls';

export type PageRangeMode = 'all' | 'odd' | 'even' | 'selected' | 'current' | 'range';

interface PageRangePickerProps {
  totalPages: number;
  preselected?: number[];
  showFilter?: boolean;
  currentPage?: number;
  onChange: (indices: number[]) => void;
  name?: string;
}

function resolveIndices(
  mode: PageRangeMode,
  totalPages: number,
  preselected: number[] | undefined,
  currentPage: number | undefined,
  fromOneBased: number,
  toOneBased: number,
): number[] {
  if (totalPages <= 0) return [];
  if (mode === 'all') return Array.from({ length: totalPages }, (_, i) => i);
  if (mode === 'odd' || mode === 'even') {
    const out: number[] = [];
    const rem = mode === 'odd' ? 1 : 0;
    for (let i = 0; i < totalPages; i++) if ((i + 1) % 2 === rem) out.push(i);
    return out;
  }
  if (mode === 'selected') {
    return [...new Set(preselected ?? [])]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < totalPages)
      .sort((a, b) => a - b);
  }
  if (mode === 'current') {
    return typeof currentPage === 'number' &&
      Number.isInteger(currentPage) &&
      currentPage >= 0 &&
      currentPage < totalPages
      ? [currentPage]
      : [];
  }
  const lo = Math.max(1, Math.min(totalPages, Math.floor(fromOneBased) || 1));
  const hi = Math.max(lo, Math.min(totalPages, Math.floor(toOneBased) || lo));
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i - 1);
  return out;
}

export function PageRangePicker({
  totalPages,
  preselected,
  showFilter = false,
  currentPage,
  onChange,
  name = 'page-range',
}: PageRangePickerProps) {
  const hasSelection = (preselected?.length ?? 0) > 0;
  const hasCurrent =
    typeof currentPage === 'number' &&
    Number.isInteger(currentPage) &&
    currentPage >= 0 &&
    currentPage < totalPages;

  const [mode, setMode] = useState<PageRangeMode>(hasSelection ? 'selected' : 'all');
  const [from, setFrom] = useState<number>(1);
  const [to, setTo] = useState<number>(Math.max(1, totalPages));

  useEffect(() => {
    setFrom((v) => Math.max(1, Math.min(totalPages, v)));
    setTo((v) => Math.max(1, Math.min(totalPages, v)));
  }, [totalPages]);

  useEffect(() => {
    if (!hasSelection && mode === 'selected') setMode('all');
  }, [hasSelection, mode]);

  useEffect(() => {
    if (!hasCurrent && mode === 'current') setMode('all');
  }, [hasCurrent, mode]);

  const indices = useMemo(
    () => resolveIndices(mode, totalPages, preselected, currentPage, from, to),
    [mode, totalPages, preselected, currentPage, from, to],
  );

  const indicesKey = indices.join(',');
  useEffect(() => {
    onChange(indices);
  }, [indicesKey]);

  const radio = (value: PageRangeMode, label: string) => (
    <div class="flex items-center gap-3">
      <Radio
        class="flex-1"
        name={name}
        value={value}
        checked={mode === value}
        onChange={() => setMode(value)}
        label={label}
      />
    </div>
  );

  const bound = (label: string, value: number, set: (n: number) => void) => (
    <NumberField
      size="sm"
      inputWidth={72}
      aria-label={label}
      value={String(value)}
      min={1}
      max={totalPages}
      step={1}
      disabled={mode !== 'range'}
      onInput={(e) => {
        const v = Number.parseInt(e.currentTarget.value, 10);
        set(Number.isFinite(v) ? v : 1);
      }}
      onFocus={() => setMode('range')}
    />
  );

  return (
    <div class="flex flex-col gap-3">
      {radio('all', 'All pages')}
      {hasCurrent ? radio('current', `Current page (${(currentPage ?? 0) + 1})`) : null}
      {showFilter ? radio('odd', 'Odd pages only') : null}
      {showFilter ? radio('even', 'Even pages only') : null}
      {hasSelection
        ? radio(
            'selected',
            preselected?.length === 1
              ? 'Selected page'
              : `Selected pages (${preselected?.length ?? 0})`,
          )
        : null}
      <div class="flex flex-wrap items-center gap-2.5">
        <div class="flex items-center gap-2">
          <Radio
            name={name}
            value="range"
            checked={mode === 'range'}
            onChange={() => setMode('range')}
            label="From:"
          />
          {bound('From page', from, setFrom)}
        </div>
        <div class="flex items-center gap-2">
          <span class="text-fg-secondary text-sm" aria-hidden="true">
            To:
          </span>
          {bound('To page', to, setTo)}
        </div>
      </div>
    </div>
  );
}
