import { MouseEvent, useEffect, useRef, suppressContentEditableWarningProps } from '@framework';
import {
  PdfFreeTextAnnoObject,
  PdfVerticalAlignment,
  freeTextFontCssProperties,
  textAlignmentToCss,
} from '@embedpdf/models';
import { useAnnotationCapability, useIOSZoomPrevention } from '../..';
import { TrackedAnnotation } from '@embedpdf/plugin-annotation';

interface FreeTextProps {
  documentId: string;
  isSelected: boolean;
  isEditing: boolean;
  annotation: TrackedAnnotation<PdfFreeTextAnnoObject>;
  pageIndex: number;
  scale: number;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: (event: MouseEvent<HTMLDivElement>) => void;
  /** When true, AP canvas provides the visual; hide text content */
  appearanceActive?: boolean;
  pageWidth?: number;
}

function activeElementFor(node: HTMLElement): Element | null {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.activeElement : document.activeElement;
}

export function FreeText({
  documentId,
  isSelected,
  isEditing,
  annotation,
  pageIndex,
  scale,
  onClick,
  appearanceActive = false,
  pageWidth,
}: FreeTextProps) {
  const editorRef = useRef<HTMLSpanElement>(null);
  const editingRef = useRef(false);
  const composingRef = useRef(false);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { provides: annotationCapability } = useAnnotationCapability();
  const annotationProvides = annotationCapability?.forDocument(documentId) ?? null;
  const { adjustedFontPx, wrapperStyle } = useIOSZoomPrevention(
    annotation.object.fontSize * scale,
    isEditing,
  );

  const seedContent = (text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.replaceChildren();
    if (!text) {
      const lineDiv = document.createElement('div');
      lineDiv.dir = 'auto';
      lineDiv.append(document.createElement('br'));
      editor.append(lineDiv);
      return;
    }
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
      if (prevChild?.nodeType === Node.TEXT_NODE && child.nodeName === 'BR') {
        continue;
      }
      const text =
        child.nodeType === Node.TEXT_NODE
          ? ((child as Text).nodeValue ?? '')
          : ((child as HTMLElement).innerText ?? '');
      buffer.push(text.replace(/\r\n?|\n/g, ''));
      prevChild = child;
    }
    return buffer.join('\n');
  };

  useEffect(() => {
    const editor = editorRef.current;
    const focused = !!editor && activeElementFor(editor) === editor;
    if (editingRef.current || focused) return;
    seedContent(annotation.object.contents);
  }, [annotation.object.contents]);

  useEffect(() => {
    if (!isEditing) return;
    editingRef.current = true;

    let cancelled = false;
    let attempts = 0;
    const MAX_FOCUS_ATTEMPTS = 12;

    const placeCaret = (editor: HTMLElement) => {
      const tool = annotationProvides?.findToolForAnnotation(annotation.object);
      const isDefaultContent =
        tool?.defaults?.contents != null &&
        tool.defaults.contents !== '' &&
        annotation.object.contents === tool.defaults.contents;
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
          seedContent(annotation.object.contents);
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

  useEffect(() => {
    return () => {
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    };
  }, []);

  const growRectToContent = () => {
    const editor = editorRef.current;
    if (!editor || !annotationProvides) return;
    const intrinsicH = editor.scrollHeight;
    const intrinsicW = editor.offsetWidth;
    const fontW = parseFloat(getComputedStyle(editor).fontSize) || 0;
    const slackW = fontW * 0.2;
    const currentH = annotation.object.rect.size.height * scale;
    const currentW = annotation.object.rect.size.width * scale;
    const grewH = intrinsicH > currentH + 1;
    const grewW = intrinsicW > currentW - slackW + 1;
    if (!grewH && !grewW) return;
    const live = annotationProvides.getAnnotationById(annotation.object.id);
    const origin = (live?.object.rect ?? annotation.object.rect).origin;
    annotationProvides.updateAnnotation(pageIndex, annotation.object.id, {
      rect: {
        origin,
        size: {
          width: grewW ? (intrinsicW + slackW) / scale : annotation.object.rect.size.width,
          height: grewH ? intrinsicH / scale : annotation.object.rect.size.height,
        },
      },
    });
  };

  const commit = () => {
    if (!annotationProvides) return;
    growRectToContent();
    const extracted = extractContent().replace(/\u00A0/g, ' ');
    if (extracted === annotation.object.contents) return;
    annotationProvides.updateAnnotation(pageIndex, annotation.object.id, {
      contents: extracted,
    });
  };

  const scheduleCommit = () => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      commit();
    }, 200);
  };

  const handleInput = () => {
    growRectToContent();
    if (composingRef.current) return;
    scheduleCommit();
  };

  const handleCompositionStart = () => {
    composingRef.current = true;
  };

  const handleCompositionEnd = () => {
    composingRef.current = false;
    growRectToContent();
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

  const editorMaxWidthPx =
    pageWidth != null
      ? Math.max(24, (pageWidth - annotation.object.rect.origin.x) * scale)
      : undefined;

  return (
    <div
      style={{
        position: 'absolute',
        width: annotation.object.rect.size.width * scale,
        height: annotation.object.rect.size.height * scale,
        cursor: isSelected && !isEditing ? 'move' : 'default',
        pointerEvents: !onClick ? 'none' : isSelected && !isEditing ? 'none' : 'auto',
        zIndex: 2,
        opacity: appearanceActive ? 0 : 1,
      }}
      onPointerDown={onClick}
    >
      <span
        ref={editorRef}
        onBlur={handleBlur}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        tabIndex={0}
        dir="auto"
        style={{
          color: annotation.object.fontColor,
          fontSize: adjustedFontPx,
          ...freeTextFontCssProperties(
            annotation.object.fontFamily,
            annotation.object.fontFamilyName,
          ),
          textAlign: textAlignmentToCss(annotation.object.textAlign),
          flexDirection: 'column',
          justifyContent:
            annotation.object.verticalAlign === PdfVerticalAlignment.Top
              ? 'flex-start'
              : annotation.object.verticalAlign === PdfVerticalAlignment.Middle
                ? 'center'
                : 'flex-end',
          display: 'flex',
          backgroundColor: annotation.object.color ?? annotation.object.backgroundColor,
          opacity: annotation.object.opacity,
          width:
            isEditing && !annotation.object.contents ? '100%' : isEditing ? 'max-content' : '100%',
          padding: isEditing && !annotation.object.contents ? 2 * scale : undefined,
          boxSizing: isEditing && !annotation.object.contents ? 'border-box' : undefined,
          maxWidth: isEditing && editorMaxWidthPx != null ? `${editorMaxWidthPx}px` : undefined,
          height: '100%',
          lineHeight: '1.18',
          overflow: isEditing && annotation.object.contents ? 'visible' : 'hidden',
          cursor: isEditing ? 'text' : onClick ? 'pointer' : 'default',
          outline: 'none',
          ...wrapperStyle,
        }}
        contentEditable={isEditing}
        {...suppressContentEditableWarningProps}
      />
    </div>
  );
}
