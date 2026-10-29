import { h, JSX } from 'preact';

export interface IconProps {
  size?: number;
  weight?: 'regular' | 'bold' | 'fill';
  class?: string;
  'aria-hidden'?: 'true';
}

export type Icon = (props: IconProps) => JSX.Element;

function icon(paths: string[]): Icon {
  return ({ size = 16, weight = 'regular', class: cls }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={weight === 'fill' ? 'currentColor' : 'none'}
      stroke="currentColor"
      stroke-width={weight === 'bold' ? 2.5 : 2}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      aria-hidden="true"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const XIcon = icon(['M18 6l-12 12', 'M6 6l12 12']);
export const PlusIcon = icon(['M12 5l0 14', 'M5 12l14 0']);
export const CheckIcon = icon(['M5 12l5 5l10 -10']);
export const TrashIcon = icon([
  'M4 7l16 0',
  'M10 11l0 6',
  'M14 11l0 6',
  'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12',
  'M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3',
]);
export const CopyIcon = icon([
  'M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z',
  'M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1',
]);
export const PencilSimpleIcon = icon([
  'M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4',
  'M13.5 6.5l4 4',
]);
export const StackIcon = icon(['M12 4l-8 4l8 4l8 -4l-8 -4', 'M4 12l8 4l8 -4', 'M4 16l8 4l8 -4']);
export const MagnetIcon = icon([
  'M4 13v-8a2 2 0 0 1 2 -2a2 2 0 0 1 2 2v8a2 2 0 0 0 6 0v-8a2 2 0 0 1 2 -2a2 2 0 0 1 2 2v8a8 8 0 0 1 -16 0',
  'M4 8l5 0',
  'M15 8l4 0',
]);
export const MagnifyingGlassPlusIcon = icon([
  'M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0',
  'M7 10l6 0',
  'M10 7l0 6',
  'M21 21l-6 -6',
]);
export const SquareIcon = icon([
  'M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z',
]);
export const CircleIcon = icon(['M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0']);
export const TriangleIcon = icon([
  'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z',
]);
export const InfoIcon = icon(['M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0', 'M12 9h.01', 'M11 12h1v4h1']);
export const WarningOctagonIcon = icon([
  'M12.802 2.165l5.575 2.389c.48 .206 .863 .589 1.07 1.07l2.388 5.574c.22 .512 .22 1.092 0 1.604l-2.389 5.575c-.206 .48 -.589 .863 -1.07 1.07l-5.574 2.388c-.512 .22 -1.092 .22 -1.604 0l-5.575 -2.389a2.036 2.036 0 0 1 -1.07 -1.07l-2.388 -5.574a2.036 2.036 0 0 1 0 -1.604l2.389 -5.575c.206 -.48 .589 -.863 1.07 -1.07l5.574 -2.388a2.036 2.036 0 0 1 1.604 0z',
  'M12 8v4',
  'M12 16h.01',
]);
