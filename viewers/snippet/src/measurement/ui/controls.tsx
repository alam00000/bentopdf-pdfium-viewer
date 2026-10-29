import { h, ComponentChildren, Fragment, JSX, createContext } from 'preact';
import { forwardRef } from 'preact/compat';
import { useContext, useId } from 'preact/hooks';

import { InfoIcon, WarningOctagonIcon } from './icons';
import {
  PAGE_RANGE_EXAMPLE,
  resolvePageScope,
  type PageScopeMode,
  type PageScopeValue,
} from './page-range';

const FieldLabel = createContext<string | undefined>(undefined);

const FIELD =
  'rounded-md border border-border-default bg-bg-input px-2 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

const field = (size?: 'sm') => `${size === 'sm' ? 'h-7' : 'h-8'} ${FIELD}`;

type ButtonVariant = 'brand' | 'secondary' | 'destructive' | 'link';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  brand: 'border border-transparent bg-accent text-fg-on-accent hover:bg-accent-hover',
  secondary:
    'border border-border-default bg-bg-surface text-fg-secondary hover:bg-interactive-hover',
  destructive:
    'border border-border-default bg-bg-surface text-state-error hover:bg-interactive-hover',
  link: 'text-accent hover:underline',
};

type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  isLoading?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  isLoading = false,
  disabled,
  type = 'button',
  class: cls,
  children,
  ...rest
}: ButtonProps) {
  const box =
    variant === 'link' ? '' : size === 'sm' ? 'h-7 rounded-md px-2.5' : 'h-9 rounded-md px-4';
  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      class={`inline-flex cursor-pointer items-center justify-center text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${box} ${BUTTON_VARIANT[variant]} ${cls ?? ''}`}
      {...rest}
    >
      {isLoading ? (
        <span
          class="mr-1.5 h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : null}
      {children}
    </button>
  );
}

const ICON_BUTTON_VARIANT = {
  ghost: 'text-fg-secondary hover:bg-interactive-hover hover:text-fg-primary',
  danger: 'text-state-error hover:bg-state-error-light',
};

type IconButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size'> & {
  variant?: 'toolbar' | 'ghost' | 'danger';
  size?: 'sm';
  active?: boolean;
  'aria-label': string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ variant = 'ghost', size, active, type = 'button', class: cls, children, ...rest }, ref) => {
    const look =
      variant === 'toolbar'
        ? `h-[32px] min-w-[32px] p-[5px] ${
            active
              ? 'bg-interactive-selected text-accent ring-accent border-none shadow ring'
              : 'hover:bg-interactive-hover hover:ring-accent hover:ring'
          }`
        : `${size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'} ${ICON_BUTTON_VARIANT[variant]}`;
    return (
      <button
        ref={ref}
        type={type}
        aria-pressed={active}
        class={`flex cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${look} ${cls ?? ''}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

type FieldProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> & {
  size?: 'sm';
};

export const TextField = forwardRef<HTMLInputElement, FieldProps>(
  ({ size, class: cls, ...rest }, ref) => {
    const labelledBy = useContext(FieldLabel);
    return (
      <input
        ref={ref}
        type="text"
        dir="auto"
        aria-labelledby={rest['aria-label'] == null ? labelledBy : undefined}
        class={`${field(size)} ${cls ?? ''}`}
        {...rest}
      />
    );
  },
);

export const NumberField = forwardRef<HTMLInputElement, FieldProps & { inputWidth?: number }>(
  ({ size, inputWidth, class: cls, ...rest }, ref) => {
    const labelledBy = useContext(FieldLabel);
    return (
      <input
        ref={ref}
        type="number"
        aria-labelledby={rest['aria-label'] == null ? labelledBy : undefined}
        class={`${field(size)} ${cls ?? ''}`}
        style={inputWidth != null ? { width: `${inputWidth}px` } : undefined}
        {...rest}
      />
    );
  },
);

interface PickerSelectProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  size?: 'sm';
  block?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

export function PickerSelect<T extends string>({
  value,
  onChange,
  options,
  size,
  placeholder,
  'aria-label': ariaLabel,
}: PickerSelectProps<T>) {
  const labelledBy = useContext(FieldLabel);
  const picked = options.some((o) => o.value === value);
  return (
    <select
      class={`${field(size)} w-full min-w-0 flex-auto pr-1`}
      value={picked ? value : ''}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel == null ? labelledBy : undefined}
      onChange={(e) => {
        const next = options.find((o) => o.value === e.currentTarget.value);
        if (next) onChange(next.value);
      }}
    >
      {picked ? null : (
        <option value="" disabled hidden>
          {placeholder ?? ''}
        </option>
      )}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function FieldGroup({
  label,
  hint,
  children,
}: {
  label?: ComponentChildren;
  hint?: ComponentChildren;
  children: ComponentChildren;
}) {
  const id = useId();
  return (
    <div class="flex flex-col gap-1.5">
      {label != null ? (
        <span id={id} class="text-fg-muted text-xs font-medium tracking-[0.04em] uppercase">
          {label}
        </span>
      ) : null}
      <FieldLabel.Provider value={label != null ? id : undefined}>{children}</FieldLabel.Provider>
      {hint != null ? <div class="text-fg-muted text-xs">{hint}</div> : null}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'danger';
  children: ComponentChildren;
}) {
  const Glyph = tone === 'danger' ? WarningOctagonIcon : InfoIcon;
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      class="text-fg-primary flex items-start gap-2 text-sm"
    >
      <Glyph
        size={16}
        class={`mt-0.5 shrink-0 ${tone === 'danger' ? 'text-state-error' : 'text-state-info'}`}
      />
      <div class="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

const NAMED_KEYS: Record<string, [string, string]> = {
  escape: ['⎋', 'Esc'],
  backspace: ['⌫', 'Backspace'],
};

export function formatShortcut(keys: readonly string[]): string {
  return keys
    .map((k) => NAMED_KEYS[k.toLowerCase()]?.[IS_MAC ? 0 : 1] ?? k)
    .join(IS_MAC ? '' : '+');
}

export function Kbd({ keys }: { keys: readonly string[] }) {
  return (
    <kbd class="whitespace-nowrap" style={{ font: 'inherit' }}>
      {formatShortcut(keys)}
    </kbd>
  );
}

export function Badge({
  class: cls,
  children,
}: {
  tone?: 'brand';
  size?: 'sm';
  icon?: null;
  class?: string;
  children: ComponentChildren;
}) {
  return (
    <span
      class={`bg-accent text-fg-on-accent inline-flex h-4 items-center rounded-full px-1.5 text-[10px] leading-none font-medium whitespace-nowrap ${cls ?? ''}`}
    >
      {children}
    </span>
  );
}

export function SidebarCard({
  selected = false,
  onSelect,
  'aria-label': ariaLabel,
  children,
}: {
  selected?: boolean;
  onSelect: () => void;
  'aria-label'?: string;
  children: ComponentChildren;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-current={selected ? 'true' : undefined}
      tabIndex={0}
      class={`focus-visible:ring-accent flex cursor-pointer flex-col gap-2 rounded-lg border px-3 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 ${
        selected
          ? 'border-accent bg-interactive-selected ring-accent ring-1'
          : 'border-border-default hover:bg-interactive-hover'
      }`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        if (!e.repeat) onSelect();
      }}
    >
      {children}
    </div>
  );
}

const SCOPE_LABEL: Record<PageScopeMode, string> = { all: 'All', range: 'Range' };

export function PageScopeField({
  value,
  onChange,
  pageCount,
  modes,
}: {
  value: PageScopeValue;
  onChange: (next: PageScopeValue) => void;
  pageCount: number;
  modes: readonly PageScopeMode[];
}) {
  const mode = modes.includes(value.mode) ? value.mode : modes[0];
  const resolved = resolvePageScope(value, { pageCount }, modes);
  const error = mode === 'range' && value.text.trim() && !resolved.ok ? resolved.message : null;
  return (
    <div class="flex flex-col gap-2">
      <div
        role="radiogroup"
        aria-label="Pages"
        class="border-border-default bg-bg-input flex rounded-md border p-0.5"
      >
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === mode}
            class={`flex-1 cursor-pointer rounded px-3 py-1 text-sm transition-colors ${
              m === mode
                ? 'bg-bg-surface text-fg-primary shadow-sm'
                : 'text-fg-secondary hover:text-fg-primary'
            }`}
            onClick={() => {
              if (m !== value.mode) onChange({ ...value, mode: m });
            }}
          >
            {SCOPE_LABEL[m]}
          </button>
        ))}
      </div>
      {mode === 'range' ? (
        <>
          <TextField
            size="sm"
            value={value.text}
            placeholder={PAGE_RANGE_EXAMPLE}
            aria-label="Page range"
            aria-invalid={error !== null}
            spellcheck={false}
            autoComplete="off"
            onInput={(e) => onChange({ ...value, mode: 'range', text: e.currentTarget.value })}
          />
          {error ? <p class="text-state-error text-xs">{error}</p> : null}
        </>
      ) : null}
    </div>
  );
}
