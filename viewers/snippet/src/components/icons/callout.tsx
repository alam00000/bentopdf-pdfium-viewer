import { h } from 'preact';
import { IconProps } from './types';

export const CalloutIcon = ({
  size = 24,
  primaryColor = 'currentColor',
  className,
  title,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    fill="none"
    stroke={primaryColor}
    stroke-width={16}
    stroke-linecap="round"
    stroke-linejoin="round"
    class={className}
    role="img"
    aria-label={title}
  >
    <rect x="40" y="48" width="176" height="96" rx="16" />
    <polyline points="176 144 176 208 72 208" />
    <polyline points="96 184 72 208 96 232" />
  </svg>
);
