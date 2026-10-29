import { h } from 'preact';
import { IconProps } from './types';

const FULL_PATH =
  'M227.32,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H216a8,8,0,0,0,0-16H115.32l112-112A16,16,0,0,0,227.32,73.37ZM136,75.31,152.69,92,68,176.69,51.31,160ZM48,208V179.31L76.69,208Zm48-3.31L79.32,188,164,103.31,180.69,120Zm96-96L147.32,64l24-24L216,84.69Z';

const STROKE_PATH = 'M32,208H216a8,8,0,0,1,0,16H48a16,16,0,0,1-16-16Z';

export const PencilMarkerIcon = ({
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
    <path d={FULL_PATH} fill={primaryColor} />
    <path d={STROKE_PATH} fill={secondaryColor ?? primaryColor} />
  </svg>
);
