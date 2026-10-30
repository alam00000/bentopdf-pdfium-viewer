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
import { CaretRightIcon, CheckIcon, XIcon } from './icons';

function Portal({ children }: { children: ComponentChildren }) {
  const [scope, setScope] = useState<ShadowRoot | Document | null>(null);
  const [, setFullscreenTick] = useState(0);
  useEffect(() => {
    if (!scope) return;
    const doc = scope instanceof ShadowRoot ? scope.ownerDocument : scope;
    const onChange = () => setFullscreenTick((t) => t + 1);
    doc.addEventListener('fullscreenchange', onChange);
    return () => doc.removeEventListener('fullscreenchange', onChange);
  }, [scope]);
  if (scope) {
    const fullscreen = scope.fullscreenElement;
    const target =
      fullscreen instanceof HTMLElement
        ? fullscreen
        : scope instanceof ShadowRoot
          ? scope
          : scope.body;
    return createPortal(children, target);
  }
  return (
    <span
      hidden
      ref={(el) => {
        if (!el) return;
        const node = el.getRootNode();
        setScope(node instanceof ShadowRoot ? node : el.ownerDocument);
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
        middleware: [offset(gap), flip(), shift({ padding: 8, crossAxis: true })],
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
  width: 'sm' | 'md' | number;
  role?: 'dialog' | 'alertdialog';
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
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

const MODAL_WIDTH = { sm: 380, md: 520 };

function ModalSurface({
  onClose,
  ariaLabel,
  width,
  role = 'dialog',
  dismissOnBackdrop = true,
  dismissOnEscape = true,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const pressInside = useRef(false);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const root = panel.getRootNode();
    const previous =
      root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
    (
      panel.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ??
      panel.querySelector<HTMLElement>(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not(:disabled)',
      ) ??
      panel
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
        if (onScrim && dismissOnBackdrop) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (dismissOnEscape) onClose();
      }}
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        class="bg-bg-surface border-border-subtle flex max-h-full max-w-full flex-col rounded-lg border shadow-lg focus:outline-none"
        style={{ width: typeof width === 'number' ? width : MODAL_WIDTH[width] }}
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

export function ModalText({ children }: { children: ComponentChildren }) {
  return <p class="text-fg-secondary text-sm">{children}</p>;
}

export function ModalActions({
  leading,
  cancelLabel,
  onCancel,
  cancelDisabled,
  confirmLabel,
  onConfirm,
  confirmVariant = 'brand',
  confirmDisabled,
  confirmLoading,
  confirmAutoFocus,
}: {
  leading?: ComponentChildren;
  cancelLabel?: ComponentChildren;
  onCancel?: () => void;
  cancelDisabled?: boolean;
  confirmLabel: ComponentChildren;
  onConfirm?: () => void;
  confirmVariant?: 'brand' | 'destructive';
  confirmDisabled?: boolean;
  confirmLoading?: boolean;
  confirmAutoFocus?: boolean;
}) {
  return (
    <div class="border-border-subtle flex shrink-0 items-center justify-end gap-3 border-t px-6 py-4">
      {leading ? <div class="mr-auto">{leading}</div> : null}
      {cancelLabel !== undefined ? (
        <Button variant="secondary" onClick={onCancel} disabled={cancelDisabled}>
          {cancelLabel}
        </Button>
      ) : null}
      <Button
        variant={confirmVariant}
        onClick={onConfirm}
        disabled={confirmDisabled}
        isLoading={confirmLoading}
        data-autofocus={confirmAutoFocus ? '' : undefined}
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

const SUBMENU_OPEN_DELAY = 150;
const SUBMENU_CLOSE_GRACE = 120;

type SubmenuHow = 'pointer' | 'keyboard';

interface SubmenuState {
  openId: string | null;
  how: SubmenuHow;
  enter: (id: string) => void;
  leave: (id: string) => void;
  openNow: (id: string, how: SubmenuHow) => void;
  close: () => void;
}

const Submenus = createContext<SubmenuState>({
  openId: null,
  how: 'pointer',
  enter: () => undefined,
  leave: () => undefined,
  openNow: () => undefined,
  close: () => undefined,
});

let submenuSeq = 0;

function useSubmenuState(): SubmenuState {
  const [openId, setOpenId] = useState<string | null>(null);
  const [how, setHow] = useState<SubmenuHow>('pointer');
  const timer = useRef<number | undefined>(undefined);
  const hovered = useRef<string | null>(null);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const openNow = (id: string, next: SubmenuHow) => {
    window.clearTimeout(timer.current);
    setHow(next);
    setOpenId(id);
  };
  return {
    openId,
    how,
    openNow,
    enter: (id) => {
      hovered.current = id;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => openNow(id, 'pointer'), SUBMENU_OPEN_DELAY);
    },
    leave: (id) => {
      if (hovered.current === id) hovered.current = null;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => setOpenId((prev) => (prev !== null && prev === hovered.current ? prev : null)),
        SUBMENU_CLOSE_GRACE,
      );
    },
    close: () => {
      window.clearTimeout(timer.current);
      setOpenId(null);
    },
  };
}

const MENU_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function ownItems(panel: HTMLElement | null): HTMLButtonElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLButtonElement>(MENU_ITEMS)).filter(
    (b) => !b.disabled && b.parentElement?.closest('[role="menu"]') === panel,
  );
}

function MenuPanel({
  reference,
  referenceKey,
  placement,
  gap,
  onClose,
  closeItems,
  dismissOutside,
  initialFocus = 'panel',
  back = false,
  panelClass,
  ariaLabel,
  children,
}: {
  reference: (panel: HTMLElement) => ReferenceElement | null;
  referenceKey: unknown;
  placement: Placement;
  gap: number;
  onClose: () => void;
  closeItems?: () => void;
  dismissOutside?: RefObject<HTMLElement | null>;
  initialFocus?: 'panel' | 'first' | 'none';
  back?: boolean;
  panelClass?: string;
  ariaLabel?: string;
  children: ComponentChildren;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const submenus = useSubmenuState();
  usePlaced(panelRef, reference, placement, gap, referenceKey);

  useEffect(() => {
    const panel = panelRef.current;
    if (initialFocus === 'panel') panel?.focus({ preventScroll: true });
    if (initialFocus === 'first') ownItems(panel)[0]?.focus({ preventScroll: true });
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
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      (closeItems ?? onClose)();
      return;
    }
    if (e.key === 'Escape' || (back && e.key === 'ArrowLeft')) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      dismissOutside?.current?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const items = ownItems(e.currentTarget);
    const n = items.length;
    if (!n) return;
    const down = e.key === 'ArrowDown';
    const at = items.findIndex((b) => b === e.target);
    items[at < 0 ? (down ? 0 : n - 1) : (at + (down ? 1 : n - 1)) % n]?.focus();
  };

  return (
    <MenuClose.Provider value={closeItems ?? onClose}>
      <Submenus.Provider value={submenus}>
        <div
          ref={panelRef}
          role="menu"
          aria-label={ariaLabel}
          tabIndex={-1}
          data-floating=""
          class={`border-border-default bg-bg-elevated z-[600] flex min-w-[220px] flex-col gap-1 rounded-lg border p-1 shadow-lg select-none focus:outline-none ${panelClass ?? ''}`}
          style={UNPLACED}
          onKeyDown={onKeyDown}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </Submenus.Provider>
    </MenuClose.Provider>
  );
}

export function Menu({
  open,
  onClose,
  triggerRef,
  align = 'end',
  side = 'bottom',
  class: cls,
  'aria-label': ariaLabel,
  children,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  class?: string;
  'aria-label'?: string;
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
        panelClass={cls}
        ariaLabel={ariaLabel}
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

const MENU_ITEM =
  'hover:bg-interactive-hover focus:bg-interactive-hover flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-[5px] px-2.5 py-1.5 text-left text-sm focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent pointer-coarse:py-2.5';

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
      class={`${MENU_ITEM} ${destructive ? 'text-state-error' : 'text-fg-primary'}`}
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
      {shortcut ? (
        <span class="text-fg-muted text-xs pointer-coarse:hidden">{formatShortcut(shortcut)}</span>
      ) : null}
      {selected ? <CheckIcon size={12} weight="bold" class="text-accent shrink-0" /> : null}
    </button>
  );
}

export function PopupMenuSubmenu({
  icon,
  label,
  disabled,
  children,
}: {
  icon?: ComponentChildren;
  label: ComponentChildren;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  const closeAll = useContext(MenuClose);
  const submenus = useContext(Submenus);
  const id = useRef(`submenu-${++submenuSeq}`).current;
  const open = submenus.openId === id;
  const rowRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      onPointerEnter={(e) => e.pointerType !== 'touch' && !disabled && submenus.enter(id)}
      onPointerLeave={(e) => e.pointerType !== 'touch' && submenus.leave(id)}
    >
      <button
        ref={rowRef}
        type="button"
        tabIndex={-1}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        class={`${MENU_ITEM} text-fg-primary ${open ? 'bg-interactive-hover' : ''}`}
        onClick={() => {
          if (disabled) return;
          if (open) submenus.close();
          else submenus.openNow(id, 'pointer');
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          submenus.openNow(id, 'keyboard');
        }}
      >
        <span class="flex w-4 shrink-0 justify-center">{icon}</span>
        <span class="min-w-0 flex-1 truncate">{label}</span>
        <CaretRightIcon size={12} weight="bold" class="text-fg-muted shrink-0" />
      </button>
      {open && !disabled ? (
        <MenuPanel
          reference={() => rowRef.current}
          referenceKey={rowRef}
          placement="right-start"
          gap={2}
          onClose={submenus.close}
          closeItems={closeAll}
          dismissOutside={rowRef}
          initialFocus={submenus.how === 'keyboard' ? 'first' : 'none'}
          back
        >
          {children}
        </MenuPanel>
      ) : null}
    </div>
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
