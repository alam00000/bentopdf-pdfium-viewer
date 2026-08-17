import { AnyPreviewState } from '@embedpdf/plugin-annotation';
import { Circle } from './annotations/circle';
import { Square } from './annotations/square';
import { Polygon } from './annotations/polygon';
import { blendModeToCss, PdfAnnotationSubtype, PdfBlendMode } from '@embedpdf/models';
import { Polyline } from './annotations/polyline';
import { Line } from './annotations/line';
import { Ink } from './annotations/ink';
import { CalloutFreeTextPreview } from './annotations/callout-free-text-preview';

interface Props {
  preview: AnyPreviewState;
  scale: number;
}

export function PreviewRenderer({ preview, scale }: Props) {
  const { bounds } = preview;

  const style = {
    position: 'absolute' as const,
    left: bounds.origin.x * scale,
    top: bounds.origin.y * scale,
    width: bounds.size.width * scale,
    height: bounds.size.height * scale,
    pointerEvents: 'none' as const,
    zIndex: 10,
  };

  // Use type guards for proper type narrowing
  if (preview.type === PdfAnnotationSubtype.CIRCLE) {
    return (
      <div style={style}>
        <Circle isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.SQUARE) {
    return (
      <div style={style}>
        <Square isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.POLYGON) {
    return (
      <div style={style}>
        <Polygon isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.POLYLINE) {
    return (
      <div style={style}>
        <Polyline isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.LINE) {
    return (
      <div style={style}>
        <Line isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.INK) {
    return (
      <div
        style={{
          ...style,
          mixBlendMode: blendModeToCss(preview.data.blendMode ?? PdfBlendMode.Normal),
        }}
      >
        <Ink isSelected={false} scale={scale} {...preview.data} />
      </div>
    );
  }

  if (preview.type === PdfAnnotationSubtype.FREETEXT) {
    if (preview.data.calloutLine) {
      return (
        <div style={style}>
          <CalloutFreeTextPreview
            calloutLine={preview.data.calloutLine}
            textBox={preview.data.textBox}
            bounds={preview.bounds}
            scale={scale}
            strokeColor={preview.data.strokeColor}
            strokeWidth={preview.data.strokeWidth}
            color={preview.data.color}
            backgroundColor={preview.data.backgroundColor}
            opacity={preview.data.opacity}
            lineEnding={preview.data.lineEnding}
          />
        </div>
      );
    }
    return (
      <div style={style}>
        {/* Render a simple dashed border preview */}
        <div
          style={{
            width: '100%',
            height: '100%',
            border: `1px dashed ${preview.data.fontColor || '#000000'}`,
            backgroundColor: 'transparent',
          }}
        />
      </div>
    );
  }

  return null;
}
