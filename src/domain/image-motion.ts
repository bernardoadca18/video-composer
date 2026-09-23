import type { StaticImagePresentation } from './contracts.js';

/** Translations are fractions of the viewport; endpoint bounds prevent exposed edges. */
export function imageTransformAt(p: StaticImagePresentation, progress: number): string {
  const t = Math.max(0, Math.min(1, progress));
  if (p.policy_version === 'static_image_presentation_v1') {
    const scale =
      p.motion === 'slow_zoom_in'
        ? 1 + p.zoom_amount * t
        : p.motion === 'slow_zoom_out'
          ? 1 + p.zoom_amount * (1 - t)
          : 1;
    return `scale(${scale})`;
  }
  const m = p.transform;
  const ease = m.easing === 'ease_in_out' ? t * t * (3 - 2 * t) : t;
  const mix = (a: number, b: number) => a + (b - a) * ease;
  return `translate(${mix(m.start_x, m.end_x) * 100}%, ${mix(m.start_y, m.end_y) * 100}%) scale(${mix(m.start_scale, m.end_scale)})`;
}
