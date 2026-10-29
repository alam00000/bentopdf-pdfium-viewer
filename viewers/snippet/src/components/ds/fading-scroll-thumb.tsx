import { h, JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

const MIN_THUMB = 30;
const MAX_THUMB = 60;
const HIDE_AFTER_MS = 1200;

export function FadingScrollThumb({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const [metrics, setMetrics] = useState({ top: 0, height: 0, needed: false });
  const [isScrolling, setIsScrolling] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isThumbHovered, setIsThumbHovered] = useState(false);
  const hideTimerRef = useRef<number | undefined>(undefined);
  const dragStartRef = useRef<{ pointerY: number; scrollTop: number } | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight <= clientHeight + 1) {
        setMetrics((m) => (m.needed ? { top: 0, height: 0, needed: false } : m));
        return;
      }
      const proportional = (clientHeight / scrollHeight) * clientHeight;
      const thumbH = Math.min(MAX_THUMB, Math.max(MIN_THUMB, proportional));
      const thumbT = Math.max(
        0,
        Math.min(
          clientHeight - thumbH,
          (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - thumbH),
        ),
      );
      setMetrics((m) =>
        m.needed && Math.abs(m.top - thumbT) < 0.5 && Math.abs(m.height - thumbH) < 0.5
          ? m
          : { top: thumbT, height: thumbH, needed: true },
      );
    };

    let raf: number | null = null;
    const schedule = () => {
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    };

    const onScroll = () => {
      schedule();
      setIsScrolling(true);
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = window.setTimeout(() => setIsScrolling(false), HIDE_AFTER_MS);
    };

    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    let content: Element | null = null;
    const followContent = () => {
      const next = el.firstElementChild;
      if (next === content) return;
      if (content) ro.unobserve(content);
      content = next;
      if (content) ro.observe(content);
    };
    followContent();
    const mo = new MutationObserver(() => {
      followContent();
      schedule();
    });
    mo.observe(el, { childList: true });

    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      mo.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
      window.clearTimeout(hideTimerRef.current);
    };
  }, [scrollRef]);

  const onThumbPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStartRef.current = { pointerY: e.clientY, scrollTop: el.scrollTop };
    setIsDragging(true);
  };

  const onThumbPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const start = dragStartRef.current;
    if (!el || !start) return;
    const { scrollHeight, clientHeight } = el;
    const trackH = clientHeight - metrics.height;
    if (trackH <= 0) return;
    const range = scrollHeight - clientHeight;
    el.scrollTop = Math.max(
      0,
      Math.min(range, start.scrollTop + ((e.clientY - start.pointerY) / trackH) * range),
    );
  };

  const onThumbPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragStartRef.current = null;
    setIsDragging(false);
  };

  if (!metrics.needed) return null;

  const visible = isScrolling || isDragging || isThumbHovered;
  const wide = isThumbHovered || isDragging;

  return (
    <div
      aria-hidden="true"
      class="pointer-events-none absolute top-0 right-0 z-[5] h-full w-3.5 transition-opacity duration-200"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div
        class={`pointer-events-auto absolute right-[3px] rounded-full transition-[width,background-color] duration-150 ${
          wide ? 'bg-scrollbar-thumb-hover' : 'bg-scrollbar-thumb'
        }`}
        style={{
          top: `${metrics.top}px`,
          height: `${metrics.height}px`,
          width: wide ? '10px' : '4px',
          cursor: isDragging ? 'grabbing' : undefined,
        }}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
        onMouseEnter={() => setIsThumbHovered(true)}
        onMouseLeave={() => setIsThumbHovered(false)}
      />
    </div>
  );
}
