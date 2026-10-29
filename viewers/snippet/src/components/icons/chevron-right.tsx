import { h } from 'preact';
import { IconProps } from './types';

export const ChevronRightIcon = ({
  size = 24,
  primaryColor = 'currentColor',
  className,
  title,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    fill={primaryColor}
    class={className}
    role="img"
    aria-label={title}
  >
    <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
  </svg>
);
