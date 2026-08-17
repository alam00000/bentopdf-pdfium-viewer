import { PdfFreeTextAnnoObject } from '@embedpdf/models';

import { PatchFunction } from '../patch-registry';
import {
  baseRotateChanges,
  baseMoveChanges,
  baseResizeScaling,
  basePropertyRotationChanges,
} from '../base-patch';
import { freeTextFontChanged, measureFreeTextContentHeight } from '../measure-free-text';

export const patchFreeText: PatchFunction<PdfFreeTextAnnoObject> = (orig, ctx) => {
  switch (ctx.type) {
    case 'move':
      if (!ctx.changes.rect) return ctx.changes;
      return baseMoveChanges(orig, ctx.changes.rect).rects;

    case 'resize':
      if (!ctx.changes.rect) return ctx.changes;
      return baseResizeScaling(orig, ctx.changes.rect, ctx.metadata).rects;

    case 'rotate':
      return baseRotateChanges(orig, ctx) ?? ctx.changes;

    case 'property-update':
      if (ctx.changes.rotation !== undefined) {
        return { ...ctx.changes, ...basePropertyRotationChanges(orig, ctx.changes.rotation) };
      }
      if (freeTextFontChanged(ctx.changes) && !orig.rotation) {
        const merged = { ...orig, ...ctx.changes };
        const needed = measureFreeTextContentHeight(merged, orig.rect.size.width);
        if (needed != null && needed > orig.rect.size.height + 0.5) {
          return {
            ...ctx.changes,
            rect: {
              origin: orig.rect.origin,
              size: { width: orig.rect.size.width, height: needed },
            },
          };
        }
      }
      return ctx.changes;

    default:
      return ctx.changes;
  }
};
