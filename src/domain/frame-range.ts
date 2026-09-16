import type { RenderManifest } from './contracts.js';

/** Operational smokes must remain a proper subset, at most 301 frames. */
export const boundedFrameRange = (
  totalFrames: number,
  frame: number,
  before: number,
  after: number,
): [number, number] => {
  if (
    ![totalFrames, frame, before, after].every(Number.isSafeInteger) ||
    totalFrames < 2 ||
    frame < 0 ||
    frame >= totalFrames ||
    before < 0 ||
    after < 0
  )
    throw new Error('Invalid bounded frame range');
  const start = Math.max(0, frame - before);
  const end = Math.min(totalFrames - 1, frame + after);
  if (end - start + 1 > 301 || end - start + 1 === totalFrames) {
    throw new Error('Smoke must be a proper subset of at most 301 frames');
  }
  return [start, end];
};

export const requiredProxyKeysForFrameRange = (
  manifest: RenderManifest,
  range: readonly [number, number],
): string[] => [
  ...new Set(
    manifest.placements.flatMap((placement) => {
      const placementEnd = placement.frame_start + placement.frame_duration - 1;
      const intersects = placement.frame_start <= range[1] && placementEnd >= range[0];
      return intersects && 'proxy_key' in placement.source ? [placement.source.proxy_key] : [];
    }),
  ),
];
