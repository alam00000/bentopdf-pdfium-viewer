import { h, Fragment } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import {
  PdfStandardFontFamily,
  STANDARD_FONT_FAMILIES,
  standardFontFamilyLabel,
} from '@embedpdf/models';

export interface SystemFontVariant {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  cssFamily: string;
}

interface SystemFontFamilyGroup {
  family: string;
  variants: SystemFontVariant[];
  defaultVariant: SystemFontVariant;
}

export type FontPick =
  | { kind: 'standard'; family: PdfStandardFontFamily }
  | { kind: 'system'; variant: SystemFontVariant };

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

function quoteIfNeeded(name: string): string {
  return /[\s,]/.test(name) ? `"${name}"` : name;
}

export function variantCssFamily(family: string, postscriptName: string): string {
  if (postscriptName && postscriptName !== family) {
    return `${quoteIfNeeded(postscriptName)}, ${quoteIfNeeded(family)}`;
  }
  return quoteIfNeeded(family);
}

function styleSortIndex(style: string): number {
  const s = style.toLowerCase();
  if (s === 'regular' || s === 'plain' || s === 'roman' || s === 'normal') return 0;
  if (s === 'italic' || s === 'oblique') return 1;
  if (s.includes('thin')) return 10;
  if (s.includes('light')) return 20;
  if (s.includes('book')) return 25;
  if (
    s.includes('semibold') ||
    s.includes('demibold') ||
    s.includes('demi bold') ||
    s.includes('semi bold')
  )
    return 35;
  if (s.includes('medium')) return 30;
  if (s.includes('bold') && s.includes('italic')) return 41;
  if (s.includes('bold')) return 40;
  if (s.includes('black') || s.includes('heavy')) return 50;
  return 100;
}

function pickDefaultVariant(variants: SystemFontVariant[]): SystemFontVariant {
  const regular = variants.find((v) => /^(regular|plain|roman|normal)$/i.test(v.style));
  return regular ?? variants[0];
}

export function isLocalFontAccessSupported(): boolean {
  return (
    typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'
  );
}

async function loadSystemFamilies(): Promise<SystemFontFamilyGroup[]> {
  const qlf = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> })
    .queryLocalFonts;
  if (typeof qlf !== 'function') return [];
  try {
    const fonts = await qlf();
    const byFamily = new Map<string, SystemFontVariant[]>();
    for (const f of fonts) {
      if (!f.family || !f.postscriptName) continue;
      const variant: SystemFontVariant = {
        family: f.family,
        fullName: f.fullName,
        postscriptName: f.postscriptName,
        style: f.style || 'Regular',
        cssFamily: variantCssFamily(f.family, f.postscriptName),
      };
      let bucket = byFamily.get(f.family);
      if (!bucket) {
        bucket = [];
        byFamily.set(f.family, bucket);
      }
      if (bucket.some((v) => v.postscriptName === variant.postscriptName)) continue;
      bucket.push(variant);
    }
    const families: SystemFontFamilyGroup[] = [];
    for (const [family, variants] of byFamily) {
      variants.sort(
        (a, b) => styleSortIndex(a.style) - styleSortIndex(b.style) || a.style.localeCompare(b.style),
      );
      families.push({ family, variants, defaultVariant: pickDefaultVariant(variants) });
    }
    families.sort((a, b) => a.family.localeCompare(b.family));
    return families;
  } catch {
    return [];
  }
}

const Chevron = ({ direction }: { direction: 'down' | 'right' }) => (
  <svg
    class={`text-fg-secondary h-4 w-4 shrink-0 ${direction === 'right' ? '-rotate-90' : ''}`}
    viewBox="0 0 20 20"
    fill="currentColor"
  >
    <path
      fillRule="evenodd"
      d="M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z"
      clipRule="evenodd"
    />
  </svg>
);

export function SystemFontPicker({
  label,
  activePostScriptName,
  activeStandardFamily,
  onPick,
  translate,
}: {
  label: string;
  activePostScriptName?: string;
  activeStandardFamily: PdfStandardFontFamily;
  onPick: (pick: FontPick) => void;
  translate: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [families, setFamilies] = useState<SystemFontFamilyGroup[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.composedPath()[0];
      if (rootRef.current && target instanceof Node && !rootRef.current.contains(target)) {
        setOpen(false);
        setExpanded(null);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    if (families !== null) return;
    let cancelled = false;
    loadSystemFamilies().then((fams) => {
      if (!cancelled) setFamilies(fams);
    });
    return () => {
      cancelled = true;
    };
  }, [open, families]);

  const supported = isLocalFontAccessSupported();
  const query = search.trim().toLowerCase();

  const filteredStandard = useMemo(
    () =>
      STANDARD_FONT_FAMILIES.filter((f) =>
        standardFontFamilyLabel(f).toLowerCase().includes(query),
      ),
    [query],
  );

  const filteredSystem = useMemo(() => {
    if (!families) return [];
    if (!query) return families;
    return families.filter(
      (f) =>
        f.family.toLowerCase().includes(query) ||
        f.variants.some((v) => v.postscriptName.toLowerCase().includes(query)),
    );
  }, [families, query]);

  const close = () => {
    setOpen(false);
    setExpanded(null);
    setSearch('');
  };

  const pickStandard = (family: PdfStandardFontFamily) => {
    onPick({ kind: 'standard', family });
    close();
  };

  const pickVariant = (variant: SystemFontVariant) => {
    onPick({ kind: 'system', variant });
    close();
  };

  return (
    <div ref={rootRef} class="relative inline-block w-full">
      <button
        type="button"
        class="border-border-default bg-bg-input flex w-full items-center justify-between gap-2 rounded border px-2 py-1 text-sm"
        onClick={() => setOpen((o) => !o)}
      >
        <span class="truncate">{label}</span>
        <Chevron direction="down" />
      </button>

      {open && (
        <div class="border-border-default bg-bg-elevated absolute z-10 mt-1 flex max-h-72 w-full flex-col rounded border shadow-lg">
          <div class="p-1">
            <input
              ref={searchRef}
              type="text"
              class="border-border-default bg-bg-input w-full rounded border px-2 py-1 text-sm outline-none"
              placeholder={translate('annotation.searchFonts')}
              value={search}
              onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-1">
            {filteredStandard.length > 0 && (
              <Fragment>
                <div class="text-fg-secondary px-2 py-1 text-xs font-medium uppercase">
                  {translate('annotation.standardFonts')}
                </div>
                {filteredStandard.map((fam) => {
                  const isActive = !activePostScriptName && fam === activeStandardFamily;
                  return (
                    <button
                      key={fam}
                      type="button"
                      class={`hover:bg-interactive-hover block w-full rounded px-2 py-1 text-left text-sm ${
                        isActive ? 'bg-interactive-hover' : ''
                      }`}
                      onClick={() => pickStandard(fam)}
                    >
                      {standardFontFamilyLabel(fam)}
                    </button>
                  );
                })}
              </Fragment>
            )}
            {supported && (
              <Fragment>
                <div class="text-fg-secondary px-2 py-1 text-xs font-medium uppercase">
                  {translate('annotation.systemFonts')}
                </div>
                {families === null && (
                  <div class="text-fg-secondary px-2 py-1 text-sm">
                    {translate('annotation.loadingFonts')}
                  </div>
                )}
                {filteredSystem.map((fam) => {
                  const isExpanded = expanded === fam.family;
                  const hasVariants = fam.variants.length > 1;
                  const familyActive =
                    !!activePostScriptName &&
                    fam.variants.some((v) => v.postscriptName === activePostScriptName);
                  return (
                    <div key={fam.family}>
                      <div
                        class={`hover:bg-interactive-hover flex w-full items-center rounded ${
                          familyActive && !isExpanded ? 'bg-interactive-hover' : ''
                        }`}
                      >
                        <button
                          type="button"
                          class="min-w-0 flex-1 truncate px-2 py-1 text-left text-sm"
                          style={{ fontFamily: fam.defaultVariant.cssFamily }}
                          onClick={() => pickVariant(fam.defaultVariant)}
                        >
                          {fam.family}
                        </button>
                        {hasVariants && (
                          <button
                            type="button"
                            class="px-1 py-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded(isExpanded ? null : fam.family);
                            }}
                          >
                            <Chevron direction={isExpanded ? 'down' : 'right'} />
                          </button>
                        )}
                      </div>
                      {isExpanded &&
                        fam.variants.map((v) => (
                          <button
                            key={v.postscriptName}
                            type="button"
                            class={`hover:bg-interactive-hover block w-full rounded py-1 pl-6 pr-2 text-left text-sm ${
                              v.postscriptName === activePostScriptName
                                ? 'bg-interactive-hover'
                                : ''
                            }`}
                            style={{ fontFamily: v.cssFamily }}
                            onClick={() => pickVariant(v)}
                          >
                            {v.style}
                          </button>
                        ))}
                    </div>
                  );
                })}
              </Fragment>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
