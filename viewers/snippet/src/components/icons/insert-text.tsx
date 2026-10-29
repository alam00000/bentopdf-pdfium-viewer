import { h } from 'preact';
import { IconProps } from './types';

export const InsertTextIcon = ({
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
        <line x1="160" y1="181" x2="213" y2="181" />
        <polyline points="192 160 213 181 192 203" />
      </g>
    </svg>
  );
};
