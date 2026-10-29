import { h } from 'preact';
import { IconProps } from './types';

export const ReplaceTextIcon = ({
  size = 24,
  primaryColor = 'currentColor',
  secondaryColor,
  className,
  title,
}: IconProps) => {
  const accent = secondaryColor ?? primaryColor;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke-width={16}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={className}
      role="img"
      aria-label={title}
    >
      <g stroke={primaryColor}>
        <polyline points="32 75 32 53 160 53 160 75" />
        <line x1="96" y1="53" x2="96" y2="203" />
        <line x1="75" y1="203" x2="117" y2="203" />
      </g>
      <g stroke={accent}>
        <polyline points="181 203 160 181 181 160" />
        <line x1="160" y1="181" x2="192" y2="181" />
        <path d="M 192 181 A 32 32 0 1 0 171 125" />
      </g>
    </svg>
  );
};
