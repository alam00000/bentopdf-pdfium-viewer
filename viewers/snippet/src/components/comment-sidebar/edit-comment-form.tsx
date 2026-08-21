import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useTranslations } from '@embedpdf/plugin-i18n/preact';

interface EditCommentFormProps {
  initialText: string;
  initialAuthor?: string;
  onSave: (newText: string, newAuthor: string) => void;
  onCancel: () => void;
  autoFocus?: boolean;
  documentId: string;
}

export const EditCommentForm = ({
  initialText,
  initialAuthor = '',
  onSave,
  onCancel,
  autoFocus = false,
  documentId,
}: EditCommentFormProps) => {
  const [text, setText] = useState(initialText);
  const [author, setAuthor] = useState(initialAuthor);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { translate } = useTranslations(documentId);

  // Focus the textarea and move the cursor to the end when the component mounts
  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [autoFocus]);

  const handleSaveClick = (e: MouseEvent) => {
    e.stopPropagation();
    onSave(text, author.trim());
  };

  const handleCancelClick = (e: MouseEvent) => {
    e.stopPropagation();
    onCancel();
  };

  return (
    <div className="flex-1 space-y-2">
      <input
        type="text"
        value={author}
        onInput={(e) => setAuthor(e.currentTarget.value)}
        placeholder={translate('comments.author')}
        aria-label={translate('comments.author')}
        className="border-border-default bg-bg-input text-fg-primary focus:border-accent focus:ring-accent w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-1"
      />
      <textarea
        ref={textareaRef}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        className="border-border-default bg-bg-input text-fg-primary focus:border-accent focus:ring-accent w-full rounded-md border px-3 py-2 text-base focus:outline-none focus:ring-1"
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={handleSaveClick}
          className="bg-accent text-fg-on-accent hover:bg-accent-hover whitespace-nowrap rounded-md px-3 py-1 text-sm"
        >
          {translate('comments.save')}
        </button>
        <button
          onClick={handleCancelClick}
          className="bg-interactive-hover text-fg-secondary hover:bg-border-default whitespace-nowrap rounded-md px-3 py-1 text-sm"
        >
          {translate('comments.cancel')}
        </button>
      </div>
    </div>
  );
};
