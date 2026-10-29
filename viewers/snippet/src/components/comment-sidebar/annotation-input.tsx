import { h, RefObject } from 'preact';
import { useState, useRef } from 'preact/hooks';

interface AnnotationInputProps {
  placeholder: string;
  onSubmit: (text: string) => void;
  inputRef?: RefObject<HTMLInputElement>;
  isFocused?: boolean;
}

export const AnnotationInput = ({
  placeholder,
  onSubmit,
  inputRef,
  isFocused,
}: AnnotationInputProps) => {
  const [text, setText] = useState('');

  const handleSubmit = (e?: h.JSX.TargetedEvent<HTMLFormElement, Event>) => {
    e?.preventDefault();
    if (text.trim()) {
      onSubmit(text);
      setText('');
    }
  };

  return (
    <form
      className="border-border-subtle mt-4 flex items-end space-x-2 border-t pt-4"
      onClick={(e) => e.stopPropagation()}
      onSubmit={handleSubmit}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        className={`bg-bg-input text-fg-primary placeholder-fg-muted w-full rounded-lg border px-3 py-1 text-base transition-colors focus:border-transparent focus:outline-none focus:ring-2 ${
          isFocused ? 'border-accent focus:ring-accent' : 'border-border-default focus:ring-accent'
        }`}
      />
      <button
        type="submit"
        disabled={!text.trim()}
        className="bg-accent text-fg-on-accent hover:bg-accent-hover disabled:bg-interactive-disabled rounded-lg p-2 transition-colors disabled:cursor-not-allowed"
      >
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 256 256">
          <path d="M231.87,114l-168-95.89A16,16,0,0,0,40.92,37.34L71.55,128,40.92,218.67A16,16,0,0,0,56,240a16.15,16.15,0,0,0,7.93-2.1l167.92-96.05a16,16,0,0,0,.05-27.89ZM56,224a.56.56,0,0,0,0-.12L85.74,136H144a8,8,0,0,0,0-16H85.74L56.06,32.16A.46.46,0,0,0,56,32l168,95.83Z" />
        </svg>
      </button>
    </form>
  );
};
