import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { Button } from './ds/controls';
import { CheckCircleIcon, WarningCircleIcon } from './ds/icons';

export const OP_COMPLETED_EVENT = 'bento:op-completed';

export type OpToastSeverity = 'success' | 'error';

export interface OpCompletedDetail {
  documentId: string;
  message: string;
  severity?: OpToastSeverity;
  action?: { label: string; onClick: () => void };
}

export function OpToast({
  documentId,
  durationMs = 2400,
}: {
  documentId: string;
  durationMs?: number;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [severity, setSeverity] = useState<OpToastSeverity>('success');
  const [action, setAction] = useState<OpCompletedDetail['action']>(undefined);
  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const unmountTimerRef = useRef<number | null>(null);

  const clearTimers = () => {
    if (hideTimerRef.current != null) window.clearTimeout(hideTimerRef.current);
    if (unmountTimerRef.current != null) window.clearTimeout(unmountTimerRef.current);
  };

  const scheduleUnmount = () => {
    unmountTimerRef.current = window.setTimeout(() => {
      setMessage(null);
      setAction(undefined);
      setShown(false);
    }, 220);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      const detail: OpCompletedDetail | undefined = e.detail;
      if (!detail || detail.documentId !== documentId) return;
      setMessage(detail.message);
      setSeverity(detail.severity ?? 'success');
      setAction(detail.action);
      setVisible(true);
      clearTimers();
      const effectiveDuration = detail.action
        ? 12000
        : (detail.severity ?? 'success') === 'error'
          ? 5000
          : durationMs;
      hideTimerRef.current = window.setTimeout(() => {
        setVisible(false);
        scheduleUnmount();
      }, effectiveDuration);
    };
    window.addEventListener(OP_COMPLETED_EVENT, handler);
    return () => {
      window.removeEventListener(OP_COMPLETED_EVENT, handler);
      clearTimers();
    };
  }, [documentId, durationMs]);

  useEffect(() => {
    if (message == null) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [message]);

  if (message == null) return null;

  const dismiss = () => {
    clearTimers();
    setVisible(false);
    scheduleUnmount();
  };

  const Glyph = severity === 'error' ? WarningCircleIcon : CheckCircleIcon;
  return (
    <div
      data-floating=""
      class="pointer-events-none absolute inset-x-0 bottom-6 z-[300] flex flex-col items-center gap-2 px-4"
    >
      <div
        role={severity === 'error' ? 'alert' : 'status'}
        class={`border-border-default bg-bg-elevated text-fg-primary pointer-events-auto flex max-w-[560px] items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm shadow-lg transition-[opacity,transform] duration-200 ${
          shown && visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        }`}
      >
        <span
          class={`flex h-5 shrink-0 items-center ${
            severity === 'error' ? 'text-state-error' : 'text-state-success'
          }`}
        >
          <Glyph size={18} weight="fill" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-fg-secondary">{message}</div>
          {action ? (
            <div class="mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  action.onClick();
                  dismiss();
                }}
              >
                {action.label}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function emitOpCompleted(detail: OpCompletedDetail): void {
  try {
    window.dispatchEvent(new CustomEvent<OpCompletedDetail>(OP_COMPLETED_EVENT, { detail }));
  } catch {}
}
