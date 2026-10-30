import { h, ComponentChildren, Ref, JSX } from 'preact';

type ButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  id?: string;
  children: ComponentChildren;
  onClick?: h.JSX.MouseEventHandler<HTMLButtonElement> | undefined;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  tooltip?: string;
  elementRef?: (el: HTMLButtonElement | null) => void;
};

export function Button({
  id,
  children,
  onClick,
  active = false,
  disabled = false,
  className = '',
  tooltip,
  elementRef,
  ...props
}: ButtonProps) {
  return (
    <button
      id={id}
      ref={elementRef}
      onClick={onClick}
      className={`flex h-[32px] w-auto min-w-[32px] items-center justify-center rounded-md p-[5px] transition-colors ${
        active ? 'ring-accent border-none ring-[1.5px] ring-inset' : 'hover:bg-interactive-hover'
      } ${disabled ? 'cursor-not-allowed opacity-50 hover:bg-transparent hover:ring-0' : 'cursor-pointer'} ${className}`}
      title={tooltip}
      {...props}
    >
      {children}
    </button>
  );
}
