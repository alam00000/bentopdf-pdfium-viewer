import { h } from 'preact';
import { useTranslations } from '@embedpdf/plugin-i18n/preact';
import type { BaseComponentProps } from '@embedpdf/plugin-ui/preact';

export function AnnotationSectionLabel({ documentId, labelKey }: BaseComponentProps) {
  const { translate } = useTranslations(documentId);
  return (
    <span class="text-fg-muted mr-2 ml-1 text-xs font-semibold tracking-[0.04em] whitespace-nowrap uppercase select-none">
      {typeof labelKey === 'string' ? translate(labelKey) : ''}
    </span>
  );
}
