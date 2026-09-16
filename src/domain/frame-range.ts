import type { RenderManifest } from './contracts.js';

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
