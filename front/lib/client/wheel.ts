const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Vertical delta of a wheel event in pixels, whatever unit the browser reports it in.
 */
export function wheelDeltaPx(event: WheelEvent, pageHeightPx: number): number {
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY * WHEEL_LINE_HEIGHT_PX;
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY * pageHeightPx;
    default:
      return event.deltaY;
  }
}
