import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  type Placement,
  type ReferenceElement,
  type VirtualElement,
} from '@floating-ui/dom';
import { h, ComponentChildren, JSX, RefObject, createContext } from 'preact';
import { createPortal } from 'preact/compat';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Button, IconButton, formatShortcut } from './controls';
import { CheckIcon, XIcon } from './icons';

function Portal({ children }: { children: ComponentChildren }) {
  const [root, setRoot] = useState<ShadowRoot | HTMLElement | null>(null);
  if (root) return createPortal(children, root);
  return (
    <span
      hidden
      ref={(el) => {
        if (!el) return;
        const node = el.getRootNode();
        setRoot(node instanceof ShadowRoot ? node : el.ownerDocument.body);
      }}
    />
  );
}

function usePlaced(
  panelRef: RefObject<HTMLElement>,
  reference: (panel: HTMLElement) => ReferenceElement | null,
  placement: Placement,
  gap: number,
  key: unknown,
): void {
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const ref = panel ? reference(panel) : null;
    if (!panel || !ref) return;
    return autoUpdate(ref, panel, () => {
      void computePosition(ref, panel, {
        strategy: 'fixed',
        placement,
        middleware: [offset(gap), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.visibility = 'visible';
      });
    });
  }, [key, placement, gap]);
}

const UNPLACED: JSX.CSSProperties = { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };

interface ModalProps {
  open: boolean;
  onClose: () => void;
  ariaLabel?: string;
  width: 'sm' | 'md';
  children: ComponentChildren;
}

export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return (
    <Portal>
      <ModalSurface {...props} />
    </Portal>
  );
}

function ModalSurface({ onClose, ariaLabel, width, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pressInside = useRef(false);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const root = panel.getRootNode();
    const previous =
      root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
    (
      panel.querySelector<HTMLElement>('input:not([type="checkbox"]):not(:disabled)') ?? panel
    ).focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return (
    <div
      data-floating=""
      role="presentation"
      class="bg-bg-overlay fixed inset-0 z-[500] flex items-center justify-center p-4"
      onMouseDown={(e) => {
        pressInside.current = e.target !== e.currentTarget;
        if (!pressInside.current) e.preventDefault();
      }}
      onClick={(e) => {
        const onScrim = e.target === e.currentTarget && !pressInside.current;
        pressInside.current = false;
        if (onScrim) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        class="bg-bg-surface border-border-subtle flex max-h-full max-w-full flex-col rounded-lg border shadow-lg focus:outline-none"
        style={{ width: width === 'sm' ? 380 : 520 }}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHeader({
  children,
  closeButton = true,
  onClose,
}: {
  children: ComponentChildren;
  closeButton?: boolean;
  onClose?: () => void;
}) {
  return (
    <div class="border-border-subtle flex shrink-0 items-center justify-between border-b px-6 py-4">
      <h2 class="text-fg-primary text-lg font-semibold">{children}</h2>
      {closeButton && onClose ? (
        <IconButton variant="ghost" size="sm" aria-label="Close" onClick={onClose}>
          <XIcon size={16} />
        </IconButton>
      ) : null}
    </div>
  );
}

export function ModalBody({ children }: { children: ComponentChildren }) {
  return <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>;
}

export function ModalActions({
  leading,
  cancelLabel,
  onCancel,
  confirmLabel,
  onConfirm,
  confirmDisabled,
  confirmLoading,
}: {
  leading?: ComponentChildren;
  cancelLabel?: ComponentChildren;
  onCancel?: () => void;
  confirmLabel: ComponentChildren;
  onConfirm?: () => void;
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
}) {
  return (
    <div class="border-border-subtle flex shrink-0 items-center justify-end gap-3 border-t px-6 py-4">
      {leading ? <div class="mr-auto">{leading}</div> : null}
      {cancelLabel !== undefined ? (
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        variant="brand"
        onClick={onConfirm}
        disabled={confirmDisabled}
        isLoading={confirmLoading}
      >
        {confirmLabel}
      </Button>
    </div>
  );
}

const BAR = 'border-border-default bg-bg-elevated select-none rounded-xl border shadow-lg';

interface FloatingMenuProps {
  hud?: 'bottom-start';
  passive?: boolean;
  anchor?: (from: Element) => ReferenceElement | null;
  placement?: Placement;
  offset?: number;
  'aria-label'?: string;
  children: ComponentChildren;
}

export function FloatingMenu({
  hud,
  passive = false,
  anchor,
  placement = 'top',
  offset: gap = 8,
  'aria-label': ariaLabel,
  children,
}: FloatingMenuProps) {
  const row = <div class="flex items-center gap-1 p-1">{children}</div>;
  if (hud) {
    return (
      <div class="pointer-events-none absolute inset-4 z-[200] flex items-end justify-start">
        <div
          data-floating=""
          aria-label={ariaLabel}
          class={`${BAR} ${passive ? '' : 'pointer-events-auto'}`}
        >
          {row}
        </div>
      </div>
    );
  }
  if (anchor) {
    return (
      <Portal>
        <AnchoredBar anchor={anchor} placement={placement} gap={gap} ariaLabel={ariaLabel}>
          {row}
        </AnchoredBar>
      </Portal>
    );
  }
  return (
    <div data-floating="" aria-label={ariaLabel} class={BAR}>
      {row}
    </div>
  );
}

function AnchoredBar({
  anchor,
  placement,
  gap,
  ariaLabel,
  children,
}: {
  anchor: (from: Element) => ReferenceElement | null;
  placement: Placement;
  gap: number;
  ariaLabel?: string;
  children: ComponentChildren;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  usePlaced(panelRef, anchor, placement, gap, anchor);
  return (
    <div
      ref={panelRef}
      data-floating=""
      aria-label={ariaLabel}
      class={`${BAR} z-[200]`}
      style={UNPLACED}
    >
      {children}
    </div>
  );
}

const MenuClose = createContext<() => void>(() => undefined);

const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function MenuPanel({
  reference,
  referenceKey,
  placement,
  gap,
  onClose,
  dismissOutside,
  ariaLabel,
  children,
}: {
  reference: (panel: HTMLElement) => ReferenceElement | null;
  referenceKey: unknown;
  placement: Placement;
  gap: number;
  onClose: () => void;
  dismissOutside?: RefObject<HTMLElement | null>;
  ariaLabel?: string;
  children: ComponentChildren;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  usePlaced(panelRef, reference, placement, gap, referenceKey);

  useEffect(() => {
    const panel = panelRef.current;
    panel?.focus({ preventScroll: true });
    if (!panel || !dismissOutside) return;
    const onDown = (e: PointerEvent) => {
      const path = e.composedPath();
      const trigger = dismissOutside.current;
      if (path.includes(panel) || (trigger && path.includes(trigger))) return;
      close.current();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [dismissOutside]);

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      if (e.key === 'Escape') dismissOutside?.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(MENU_ITEMS),
    ).filter((b) => !b.disabled);
    const n = items.length;
    if (!n) return;
    const down = e.key === 'ArrowDown';
    const at = items.findIndex((b) => b === e.target);
    items[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n]?.focus();
  };

  return (
    <MenuClose.Provider value={onClose}>
      <div
        ref={panelRef}
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        data-floating=""
        class="border-border-default bg-bg-elevated z-[600] min-w-[180px] rounded-lg border py-1 shadow-lg select-none focus:outline-none"
        style={UNPLACED}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </MenuClose.Provider>
  );
}

export function Menu({
  open,
  onClose,
  triggerRef,
  align = 'end',
  side = 'bottom',
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  children: ComponentChildren;
}) {
  if (!open) return null;
  return (
    <Portal>
      <MenuPanel
        reference={() => triggerRef.current}
        referenceKey={triggerRef}
        placement={`${side}-${align}`}
        gap={4}
        onClose={onClose}
        dismissOutside={triggerRef}
      >
        {children}
      </MenuPanel>
    </Portal>
  );
}

function pointAt(p: { x: number; y: number }): VirtualElement {
  return { getBoundingClientRect: () => new DOMRect(p.x, p.y, 0, 0) };
}

export function PopupMenu({
  position,
  onClose,
  'aria-label': ariaLabel,
  children,
}: {
  position: { x: number; y: number };
  onClose: () => void;
  'aria-label'?: string;
  children: ComponentChildren;
}) {
  return (
    <Portal>
      <div
        data-floating=""
        class="fixed inset-0 z-[600]"
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <MenuPanel
          reference={() => pointAt(position)}
          referenceKey={`${position.x},${position.y}`}
          placement="bottom-start"
          gap={0}
          onClose={onClose}
          ariaLabel={ariaLabel}
        >
          {children}
        </MenuPanel>
      </div>
    </Portal>
  );
}

export function PopupMenuItem({
  icon,
  label,
  shortcut,
  disabled,
  destructive,
  selected,
  keepOpen,
  onClick,
}: {
  icon?: ComponentChildren;
  label: ComponentChildren;
  shortcut?: readonly string[];
  disabled?: boolean;
  destructive?: boolean;
  selected?: boolean;
  keepOpen?: boolean;
  onClick?: () => void;
}) {
  const close = useContext(MenuClose);
  return (
    <button
      type="button"
      tabIndex={-1}
      role={selected === undefined ? 'menuitem' : keepOpen ? 'menuitemcheckbox' : 'menuitemradio'}
      aria-checked={selected}
      disabled={disabled}
      class={`hover:bg-interactive-hover focus:bg-interactive-hover flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        destructive ? 'text-state-error' : 'text-fg-primary'
      }`}
      onClick={() => {
        if (disabled) return;
        try {
          onClick?.();
        } finally {
          if (!keepOpen) close();
        }
      }}
    >
      <span class="flex w-4 shrink-0 justify-center">{icon}</span>
      <span class="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? <span class="text-fg-muted text-xs">{formatShortcut(shortcut)}</span> : null}
      {selected ? <CheckIcon size={12} weight="bold" class="text-accent shrink-0" /> : null}
    </button>
  );
}

export function PopupMenuLabel({ children }: { children: ComponentChildren }) {
  return (
    <div
      role="presentation"
      class="text-fg-muted px-3 pt-2 pb-1 text-xs font-medium tracking-[0.04em] uppercase"
    >
      {children}
    </div>
  );
}

export function PopupMenuDivider() {
  return <div role="separator" class="border-border-subtle my-1 border-t" />;
}
