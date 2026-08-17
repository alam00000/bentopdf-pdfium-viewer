import {
  MouseEvent,
  useEffect,
  useRef,
  useMemo,
  suppressContentEditableWarningProps,
} from '@framework';
import {
  PdfFreeTextAnnoObject,
  PdfVerticalAlignment,
  freeTextFontCssProperties,
  textAlignmentToCss,
} from '@embedpdf/models';
import { useAnnotationCapability, useIOSZoomPrevention } from '../..';
import { TrackedAnnotation } from '@embedpdf/plugin-annotation';
import { patching } from '@embedpdf/plugin-annotation';

const MIN_HIT_AREA_SCREEN_PX = 20;

interface CalloutFreeTextProps {
  documentId: string;
  isSelected: boolean;
  isEditing: boolean;
  annotation: TrackedAnnotation<PdfFreeTextAnnoObject>;
  pageIndex: number;
  scale: number;
  onClick?: (e: MouseEvent<Element>) => void;
  appearanceActive?: boolean;
  pageRotation?: number;
}

function activeElementFor(node: HTMLElement): Element | null {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.activeElement : document.activeElement;
}

export function CalloutFreeText({
  documentId,
  isSelected,
  isEditing,
  annotation,
  pageIndex,
  scale,
  onClick,
  appearanceActive = false,
  pageRotation = 0,
}: CalloutFreeTextProps) {
  const editorRef = useRef<HTMLSpanElement>(null);
  const editingRef = useRef(false);
  const composingRef = useRef(false);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { provides: annotationCapability } = useAnnotationCapability();
  const annotationProvides = annotationCapability?.forDocument(documentId) ?? null;

  const obj = annotation.object;

  const seedContent = (text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren();
    if (!text) return;
    for (const line of text.split(/\r\n?|\n/)) {
      const lineDiv = document.createElement('div');
      lineDiv.dir = 'auto';
      lineDiv.append(line ? document.createTextNode(line) : document.createElement('br'));
      editor.append(lineDiv);
    }
  };
  const extractContent = (): string => {
    const editor = editorRef.current;
    if (!editor) return '';
    editor.normalize();
    const buffer: string[] = [];
    let prevChild: Node | null = null;
    for (const child of Array.from(editor.childNodes)) {
      if (prevChild?.nodeType === Node.TEXT_NODE && child.nodeName === 'BR') continue;
      const text =
        child.nodeType === Node.TEXT_NODE
          ? ((child as Text).nodeValue ?? '')
          : ((child as HTMLElement).innerText ?? '');
      buffer.push(text.replace(/\r\n?|\n/g, ''));
      prevChild = child;
    }
    return buffer.join('\n');
  };
  const rect = obj.rect;
  const rd = obj.rectangleDifferences;
  const calloutLine = obj.calloutLine;
  const strokeWidth = obj.strokeWidth ?? 1;
  const strokeColor = obj.strokeColor ?? '#000000';

  const textBox = useMemo(() => patching.computeTextBoxFromRD(rect, rd), [rect, rd]);

  const textBoxRelative = useMemo(
    () => ({
      left: (textBox.origin.x - rect.origin.x + strokeWidth / 2) * scale,
      top: (textBox.origin.y - rect.origin.y + strokeWidth / 2) * scale,
      width: (textBox.size.width - strokeWidth) * scale,
      height: (textBox.size.height - strokeWidth) * scale,
    }),
    [textBox, rect, scale, strokeWidth],
  );

  const lineCoords = useMemo(() => {
    if (!calloutLine || calloutLine.length < 3) return null;
    return calloutLine.map((p) => ({
      x: p.x - rect.origin.x,
      y: p.y - rect.origin.y,
    }));
  }, [calloutLine, rect]);

  const ending = useMemo(() => {
    if (!lineCoords || lineCoords.length < 2) return null;
    const angle = Math.atan2(lineCoords[1].y - lineCoords[0].y, lineCoords[1].x - lineCoords[0].x);
    return patching.createEnding(
      obj.lineEnding,
      strokeWidth,
      angle + Math.PI,
      lineCoords[0].x,
      lineCoords[0].y,
    );
  }, [lineCoords, obj.lineEnding, strokeWidth]);

  const visualLineCoords = useMemo(() => {
    if (!lineCoords || lineCoords.length < 2) return lineCoords;
    const pts = lineCoords.map((p) => ({ ...p }));
    const last = pts.length - 1;
    const prev = last - 1;
    const dx = pts[last].x - pts[prev].x;
    const dy = pts[last].y - pts[prev].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const halfBw = strokeWidth / 2;
      pts[last].x += (dx / len) * halfBw;
      pts[last].y += (dy / len) * halfBw;
    }
    return pts;
  }, [lineCoords, strokeWidth]);

  const { adjustedFontPx, wrapperStyle } = useIOSZoomPrevention(obj.fontSize * scale, isEditing);

  const textCounterRotation = useMemo(() => {
    const counterDeg = ((4 - (pageRotation & 3)) % 4) * 90;
    if (counterDeg === 0) return null;
    const quarterTurned = counterDeg === 90 || counterDeg === 270;
    const width = quarterTurned ? textBoxRelative.height : textBoxRelative.width;
    const height = quarterTurned ? textBoxRelative.width : textBoxRelative.height;
    return {
      left: textBoxRelative.left + (textBoxRelative.width - width) / 2,
      top: textBoxRelative.top + (textBoxRelative.height - height) / 2,
      width,
      height,
      transform: `rotate(${counterDeg}deg)`,
    };
  }, [pageRotation, textBoxRelative]);

  const textLayout = textCounterRotation ?? textBoxRelative;
  const composedTransform = [wrapperStyle?.transform, textCounterRotation?.transform]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    const editor = editorRef.current;
    const focused = !!editor && activeElementFor(editor) === editor;
    if (editingRef.current || focused) return;
    seedContent(obj.contents);
  }, [obj.contents]);

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isEditing) return;
    editingRef.current = true;

    let cancelled = false;
    let attempts = 0;
    const MAX_FOCUS_ATTEMPTS = 12;

    const placeCaret = (editor: HTMLElement) => {
      const tool = annotationProvides?.findToolForAnnotation(obj);
      const isDefaultContent =
        tool?.defaults?.contents != null && obj.contents === tool.defaults.contents;
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (!isDefaultContent) {
        range.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(range);
    };

    let seeded = false;
    const tryFocus = () => {
      if (cancelled) return;
      const editor = editorRef.current;
      if (editor) {
        if (!seeded) {
          seeded = true;
          seedContent(obj.contents);
        }
        if (activeElementFor(editor) === editor) {
          placeCaret(editor);
          return;
        }
        editor.focus({ preventScroll: true });
        if (activeElementFor(editor) === editor) {
          placeCaret(editor);
          return;
        }
      }
      if (++attempts < MAX_FOCUS_ATTEMPTS) {
        requestAnimationFrame(tryFocus);
      }
    };
    tryFocus();

    return () => {
      cancelled = true;
    };
  }, [isEditing]);

  const commit = () => {
    if (!annotationProvides || !editorRef.current) return;
    const extracted = extractContent().replace(/\u00A0/g, ' ');
    if (extracted === obj.contents) return;
    annotationProvides.updateAnnotation(pageIndex, obj.id, { contents: extracted });
  };
  const scheduleCommit = () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      commit();
    }, 200);
  };
  const handleInput = () => {
    if (composingRef.current) return;
    scheduleCommit();
  };
  const handleCompositionStart = () => {
    composingRef.current = true;
  };
  const handleCompositionEnd = () => {
    composingRef.current = false;
    scheduleCommit();
  };
  const handleBlur = () => {
    editingRef.current = false;
    if (composingRef.current) return;
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    commit();
  };

  const width = rect.size.width * scale;
  const height = rect.size.height * scale;
  const hitStrokeWidth = Math.max(strokeWidth, MIN_HIT_AREA_SCREEN_PX / scale);

  return (
    <div
      style={{
        position: 'absolute',
        width,
        height,
        cursor: isSelected && !isEditing ? 'move' : 'default',
        pointerEvents: 'none',
        zIndex: 2,
        opacity: appearanceActive ? 0 : 1,
      }}
    >
      <svg
        style={{
          position: 'absolute',
          width,
          height,
          pointerEvents: 'none',
          overflow: 'visible',
        }}
        width={width}
        height={height}
        viewBox={`0 0 ${rect.size.width} ${rect.size.height}`}
      >
        {lineCoords && (
          <>
            <polyline
              points={lineCoords.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="transparent"
              strokeWidth={hitStrokeWidth}
              onPointerDown={onClick ? (e) => onClick(e) : undefined}
              style={{
                cursor: isSelected ? 'move' : onClick ? 'pointer' : 'default',
                pointerEvents: !onClick ? 'none' : isSelected ? 'none' : 'visibleStroke',
              }}
            />
            {ending && (
              <path
                d={ending.d}
                transform={ending.transform}
                fill="transparent"
                stroke="transparent"
                strokeWidth={hitStrokeWidth}
                onPointerDown={onClick ? (e) => onClick(e) : undefined}
                style={{
                  cursor: isSelected ? 'move' : onClick ? 'pointer' : 'default',
                  pointerEvents: !onClick
                    ? 'none'
                    : isSelected
                      ? 'none'
                      : ending.filled
                        ? 'visible'
                        : 'visibleStroke',
                }}
              />
            )}
          </>
        )}

        {!appearanceActive && (
          <>
            {visualLineCoords && (
              <>
                <polyline
                  points={visualLineCoords.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  opacity={obj.opacity}
                  style={{ pointerEvents: 'none' }}
                />
                {ending && (
                  <path
                    d={ending.d}
                    transform={ending.transform}
                    stroke={strokeColor}
                    fill={ending.filled ? (obj.color ?? 'transparent') : 'none'}
                    strokeWidth={strokeWidth}
                    opacity={obj.opacity}
                    style={{ pointerEvents: 'none' }}
                  />
                )}
              </>
            )}
            <rect
              x={textBox.origin.x - rect.origin.x + strokeWidth / 2}
              y={textBox.origin.y - rect.origin.y + strokeWidth / 2}
              width={textBox.size.width - strokeWidth}
              height={textBox.size.height - strokeWidth}
              fill={obj.color ?? obj.backgroundColor ?? 'transparent'}
              stroke={strokeColor}
              strokeWidth={strokeWidth}
              opacity={obj.opacity}
              style={{ pointerEvents: 'none' }}
            />
          </>
        )}
      </svg>

      <div
        onPointerDown={onClick ? (e) => onClick(e) : undefined}
        style={{
          position: 'absolute',
          left: (textBox.origin.x - rect.origin.x) * scale,
          top: (textBox.origin.y - rect.origin.y) * scale,
          width: textBox.size.width * scale,
          height: textBox.size.height * scale,
          cursor: isSelected && !isEditing ? 'move' : onClick ? 'pointer' : 'default',
          pointerEvents: !onClick ? 'none' : isSelected && !isEditing ? 'none' : 'auto',
        }}
      />

      <span
        ref={editorRef}
        onBlur={handleBlur}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        tabIndex={0}
        dir="auto"
        style={{
          position: 'absolute',
          left: textLayout.left,
          top: textLayout.top,
          width: textLayout.width,
          height: textLayout.height,
          color: obj.fontColor,
          fontSize: adjustedFontPx,
          ...freeTextFontCssProperties(obj.fontFamily, obj.fontFamilyName),
          textAlign: textAlignmentToCss(obj.textAlign),
          flexDirection: 'column',
          justifyContent:
            obj.verticalAlign === PdfVerticalAlignment.Top
              ? 'flex-start'
              : obj.verticalAlign === PdfVerticalAlignment.Middle
                ? 'center'
                : 'flex-end',
          display: 'flex',
          padding: (strokeWidth * scale) / 2 + 2 * scale,
          opacity: obj.opacity,
          lineHeight: '1.18',
          overflow: 'hidden',
          cursor: isEditing ? 'text' : 'default',
          outline: 'none',
          pointerEvents: isEditing ? 'auto' : 'none',
          ...wrapperStyle,
          ...(textCounterRotation && {
            transform: composedTransform,
            transformOrigin: 'center center',
          }),
        }}
        contentEditable={isEditing}
        {...suppressContentEditableWarningProps}
      />
    </div>
  );
}
