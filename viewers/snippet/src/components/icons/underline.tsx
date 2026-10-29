import { h } from 'preact';
import { IconProps } from './types';

export const UnderlineIcon = ({
  size = 24,
  primaryColor = 'currentColor',
  secondaryColor,
  className,
  title,
}: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    aria-label={title}
  >
    <path
      d="M128,200a64.07,64.07,0,0,0,64-64V56a8,8,0,0,0-16,0v80a48,48,0,0,1-96,0V56a8,8,0,0,0-16,0v80A64.07,64.07,0,0,0,128,200Z"
      fill={primaryColor}
    />
    <path
      d="M200,224a8,8,0,0,1-8,8H64a8,8,0,0,1,0-16H192A8,8,0,0,1,200,224Z"
      fill={secondaryColor ?? primaryColor}
    />
  </svg>
);
