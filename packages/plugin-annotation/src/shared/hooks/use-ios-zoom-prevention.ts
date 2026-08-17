import { useMemo, CSSProperties } from '@framework';

const MIN_IOS_FOCUS_FONT_PX = 16;

function detectIOS(): boolean {
  try {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  } catch {
    return false;
  }
}

let _isIOS: boolean | undefined;
function getIsIOS(): boolean {
  if (_isIOS === undefined) {
    _isIOS = detectIOS();
  }
  return _isIOS;
}

export function useIOSZoomPrevention(computedFontPx: number, active: boolean) {
  const isIOS = getIsIOS();

  return useMemo(() => {
    const needsComp =
      isIOS && active && computedFontPx > 0 && computedFontPx < MIN_IOS_FOCUS_FONT_PX;
    const adjustedFontPx = needsComp ? MIN_IOS_FOCUS_FONT_PX : computedFontPx;
    const scaleComp = needsComp ? computedFontPx / MIN_IOS_FOCUS_FONT_PX : 1;

    const wrapperStyle: CSSProperties | undefined = needsComp
      ? {
          width: `${100 / scaleComp}%`,
          height: `${100 / scaleComp}%`,
          transform: `scale(${scaleComp})`,
          transformOrigin: 'top left',
        }
      : undefined;

    return { needsComp, adjustedFontPx, scaleComp, wrapperStyle };
  }, [isIOS, active, computedFontPx]);
}
