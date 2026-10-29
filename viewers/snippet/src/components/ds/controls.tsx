import { h, ComponentChildren, Fragment, JSX, createContext, type VNode } from 'preact';
import { forwardRef } from 'preact/compat';
import { useContext, useId, useState } from 'preact/hooks';
import type { Placement } from '@floating-ui/dom';

import { Tooltip } from '../ui/tooltip';
import { EyeIcon, EyeSlashIcon, InfoIcon, WarningOctagonIcon } from './icons';
import {
  PAGE_RANGE_EXAMPLE,
  resolvePageScope,
  type PageScopeMode,
  type PageScopeValue,
} from './page-range';

const FieldLabel = createContext<string | undefined>(undefined);

const FIELD =
  'rounded-md border border-border-default bg-bg-input px-2 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50';

const INVALID = 'border-state-error focus:border-state-error focus:ring-state-error';

const field = (size?: 'sm', invalid?: boolean) =>
  `${size === 'sm' ? 'h-7' : 'h-8'} ${FIELD} ${invalid ? INVALID : ''}`;

function withTooltip(
  node: VNode,
  tooltip: ComponentChildren | undefined,
  position: Placement = 'top',
): VNode {
  if (tooltip == null) return node;
  return (
    <Tooltip content={tooltip} position={position} delay={500}>
      {node}
    </Tooltip>
  );
}

type ButtonVariant = 'brand' | 'secondary' | 'destructive' | 'link' | 'toolbar' | 'ghost';

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  brand: 'border border-transparent bg-accent text-fg-on-accent hover:bg-accent-hover',
  secondary:
    'border border-border-default bg-bg-surface text-fg-secondary hover:bg-interactive-hover',
  destructive:
    'border border-border-default bg-bg-surface text-state-error hover:bg-interactive-hover',
  link: 'text-accent hover:underline',
  toolbar:
    'border border-transparent text-fg-primary hover:bg-interactive-hover hover:ring hover:ring-accent disabled:hover:bg-transparent disabled:hover:ring-0',
  ghost:
    'border border-transparent text-fg-secondary hover:bg-interactive-hover hover:text-fg-primary disabled:hover:bg-transparent',
};

type ButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'ref'> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  isLoading?: boolean;
  leadingIcon?: ComponentChildren;
  trailingIcon?: ComponentChildren;
  tooltip?: ComponentChildren;
  tooltipPosition?: Placement;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'secondary',
      size = 'md',
      isLoading = false,
      leadingIcon,
      trailingIcon,
      tooltip,
      tooltipPosition,
      disabled,
      type = 'button',
      class: cls,
      children,
      ...rest
    },
    ref,
  ) => {
    const box =
      variant === 'link'
        ? ''
        : variant === 'toolbar'
          ? 'h-8 rounded-md px-2.5'
          : size === 'sm'
            ? 'h-7 rounded-md px-2.5'
            : 'h-9 rounded-md px-4';
    return withTooltip(
      <button
        ref={ref}
        type={type}
        disabled={disabled || isLoading}
        aria-busy={isLoading || undefined}
        class={`inline-flex cursor-pointer items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${box} ${BUTTON_VARIANT[variant]} ${cls ?? ''}`}
        {...rest}
      >
        {isLoading ? (
          <span
            class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
        ) : leadingIcon ? (
          <span class="flex shrink-0 items-center">{leadingIcon}</span>
        ) : null}
        {children}
        {trailingIcon ? <span class="flex shrink-0 items-center">{trailingIcon}</span> : null}
      </button>,
      tooltip,
      tooltipPosition,
    );
  },
);

const ICON_BUTTON_VARIANT = {
  ghost:
    'text-fg-secondary hover:bg-interactive-hover hover:text-fg-primary disabled:hover:bg-transparent',
  danger: 'text-state-error hover:bg-state-error-light disabled:hover:bg-transparent',
};

type IconButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'ref'> & {
  variant?: 'toolbar' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  active?: boolean;
  tooltip?: ComponentChildren;
  tooltipPosition?: Placement;
  'aria-label': string;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      variant = 'ghost',
      size,
      active,
      tooltip,
      tooltipPosition,
      type = 'button',
      class: cls,
      children,
      ...rest
    },
    ref,
  ) => {
    const look =
      variant === 'toolbar'
        ? `h-[32px] min-w-[32px] p-[5px] ${
            active
              ? 'bg-interactive-selected text-accent ring-accent border-none shadow ring'
              : 'hover:bg-interactive-hover hover:ring-accent hover:ring disabled:hover:bg-transparent disabled:hover:ring-0'
          }`
        : `${size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'} ${ICON_BUTTON_VARIANT[variant]}`;
    return withTooltip(
      <button
        ref={ref}
        type={type}
        aria-pressed={active}
        class={`flex cursor-pointer items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${look} ${cls ?? ''}`}
        {...rest}
      >
        {children}
      </button>,
      tooltip,
      tooltipPosition,
    );
  },
);

type FieldProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type' | 'prefix'> & {
  size?: 'sm';
  invalid?: boolean;
  onValueChange?: (value: string) => void;
};

export const TextField = forwardRef<
  HTMLInputElement,
  FieldProps & { type?: 'text' | 'password'; suffix?: ComponentChildren }
>(({ size, invalid, onValueChange, onInput, type = 'text', suffix, class: cls, ...rest }, ref) => {
  const labelledBy = useContext(FieldLabel);
  const input = (
    <input
      ref={ref}
      type={type}
      dir="auto"
      aria-labelledby={rest['aria-label'] == null ? labelledBy : undefined}
      aria-invalid={invalid || undefined}
      class={`${field(size, invalid)} ${suffix ? 'w-full pr-8' : ''} ${cls ?? ''}`}
      onInput={(e) => {
        onInput?.(e);
        onValueChange?.(e.currentTarget.value);
      }}
      {...rest}
    />
  );
  if (suffix == null) return input;
  return (
    <div class="relative flex w-full items-center">
      {input}
      <span class="absolute right-1 flex items-center">{suffix}</span>
    </div>
  );
});

export const PasswordField = forwardRef<
  HTMLInputElement,
  FieldProps & { onSubmit?: (value: string) => void }
>(({ onSubmit, onKeyDown, disabled, ...rest }, ref) => {
  const [revealed, setRevealed] = useState(false);
  return (
    <TextField
      ref={ref}
      type={revealed ? 'text' : 'password'}
      autoComplete="off"
      spellcheck={false}
      disabled={disabled}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented || e.key !== 'Enter' || !onSubmit) return;
        e.preventDefault();
        onSubmit(e.currentTarget.value);
      }}
      suffix={
        <IconButton
          variant="ghost"
          size="sm"
          class="h-6 w-6"
          tabIndex={-1}
          aria-label="Show password"
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
        </IconButton>
      }
      {...rest}
    />
  );
});

export const NumberField = forwardRef<
  HTMLInputElement,
  FieldProps & { inputWidth?: number; prefix?: string }
>(({ size, invalid, onValueChange, onInput, inputWidth, prefix, class: cls, ...rest }, ref) => {
  const labelledBy = useContext(FieldLabel);
  const input = (
    <input
      ref={ref}
      type="number"
      aria-labelledby={rest['aria-label'] == null ? labelledBy : undefined}
      aria-invalid={invalid || undefined}
      class={`${field(size, invalid)} ${prefix ? 'w-full pl-7' : (cls ?? '')}`}
      style={inputWidth != null ? { width: `${inputWidth}px` } : undefined}
      onInput={(e) => {
        onInput?.(e);
        onValueChange?.(e.currentTarget.value);
      }}
      {...rest}
    />
  );
  if (!prefix) return input;
  return (
    <div class={`relative flex items-center ${cls ?? ''}`}>
      <span
        class="text-fg-muted pointer-events-none absolute left-2 text-xs font-medium"
        aria-hidden="true"
      >
        {prefix}
      </span>
      {input}
    </div>
  );
});

interface PickerSelectProps<T extends string | number> {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string }[];
  size?: 'sm';
  block?: boolean;
  disabled?: boolean;
  placeholder?: string;
  'aria-label'?: string;
}

export function PickerSelect<T extends string | number>({
  value,
  onChange,
  options,
  size,
  disabled,
  placeholder,
  'aria-label': ariaLabel,
}: PickerSelectProps<T>) {
  const labelledBy = useContext(FieldLabel);
  const picked = options.some((o) => o.value === value);
  return (
    <select
      class={`${field(size)} w-full min-w-0 flex-auto pr-1`}
      value={picked ? String(value) : ''}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel == null ? labelledBy : undefined}
      onChange={(e) => {
        const next = options.find((o) => String(o.value) === e.currentTarget.value);
        if (next) onChange(next.value);
      }}
    >
      {picked ? null : (
        <option value="" disabled hidden>
          {placeholder ?? ''}
        </option>
      )}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const LABEL = 'text-fg-muted text-xs font-medium tracking-[0.04em] uppercase';

export function Label({ children }: { children: ComponentChildren }) {
  return <span class={LABEL}>{children}</span>;
}

export function FieldGroup({
  label,
  labelAction,
  hint,
  error,
  children,
}: {
  label?: ComponentChildren;
  labelAction?: ComponentChildren;
  hint?: ComponentChildren;
  error?: ComponentChildren;
  children: ComponentChildren;
}) {
  const id = useId();
  return (
    <div class="flex flex-col gap-1.5">
      {label != null || labelAction != null ? (
        <div class="flex items-center justify-between gap-2">
          {label != null ? (
            <span id={id} class={LABEL}>
              {label}
            </span>
          ) : null}
          {labelAction}
        </div>
      ) : null}
      <FieldLabel.Provider value={label != null ? id : undefined}>{children}</FieldLabel.Provider>
      {error != null ? (
        <Notice tone="danger">{error}</Notice>
      ) : hint != null ? (
        <div class="text-fg-muted text-xs">{hint}</div>
      ) : null}
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

export function Radio({
  name,
  value,
  checked,
  onChange,
  label,
  disabled,
  class: cls,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ComponentChildren;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <label
      class={`text-fg-primary inline-flex items-center gap-2 text-sm select-none ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      } ${cls ?? ''}`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        class="accent-accent m-0 h-4 w-4 shrink-0 cursor-[inherit]"
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function RadioGroup({
  'aria-label': ariaLabel,
  children,
}: {
  'aria-label'?: string;
  children: ComponentChildren;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} class="flex flex-col gap-2.5">
      {children}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ComponentChildren;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const selected = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    const next =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? (i + 1) % n
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? (i - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (next < 0 || disabled) return;
    e.preventDefault();
    const buttons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[next]?.focus();
    const opt = options[next];
    if (opt && next !== selected) onChange(opt.value);
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      class="border-border-default bg-bg-input flex rounded-md border p-0.5"
    >
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            disabled={disabled}
            class={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              on
                ? 'bg-bg-surface text-fg-primary shadow-sm'
                : 'text-fg-secondary hover:text-fg-primary'
            }`}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ProgressBar({
  value,
  max,
  class: cls,
  'aria-label': ariaLabel,
}: {
  value: number;
  max: number;
  class?: string;
  'aria-label': string;
}) {
  const top = Number.isFinite(max) && max > 0 ? max : 1;
  const now = Number.isFinite(value) ? Math.min(top, Math.max(0, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={top}
      aria-valuenow={now}
      class={`bg-interactive-hover h-1.5 overflow-hidden rounded-full ${cls ?? ''}`}
    >
      <div
        class="bg-accent h-full rounded-full transition-[width] duration-200"
        style={{ width: `${(now / top) * 100}%` }}
      />
    </div>
  );
}

export function DropOverlay({ hint }: { hint?: string }) {
  return (
    <div
      aria-hidden="true"
      class="border-accent bg-bg-surface/85 pointer-events-none absolute inset-2 z-[100] flex animate-[bento-fade-in_160ms_ease-out] flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed p-4 text-center backdrop-blur-md motion-reduce:animate-none"
    >
      <span class="text-fg-primary text-2xl font-semibold">Drop Here</span>
      {hint ? <span class="text-fg-secondary max-w-[40ch] text-sm">{hint}</span> : null}
    </div>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

const NAMED_KEYS: Record<string, [string, string]> = {
  escape: ['Esc', 'Esc'],
  backspace: ['⌫', 'Backspace'],
  mod: ['⌘', 'Ctrl'],
  shift: ['⇧', 'Shift'],
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

const SCOPE_OPTIONS: Record<PageScopeMode, SegmentedOption<PageScopeMode>> = {
  all: { value: 'all', label: 'All' },
  range: { value: 'range', label: 'Range' },
};

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
      <SegmentedControl
        aria-label="Pages"
        options={modes.map((m) => SCOPE_OPTIONS[m])}
        value={mode ?? 'all'}
        onChange={(m) => {
          if (m !== value.mode) onChange({ ...value, mode: m });
        }}
      />
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
