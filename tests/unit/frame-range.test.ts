import { describe, expect, it } from 'vitest';

import { boundedFrameRange, requiredProxyKeysForFrameRange } from '../../src/domain/frame-range.js';
import { renderManifest } from '../helpers.js';

describe('targeted render asset selection', () => {
  it('requires only proxies intersecting the inclusive frame range', () => {
    const manifest = renderManifest('/tmp/frame-range');
    const first = manifest.placements[0]!;
    const second = manifest.placements[1]!;
    expect(requiredProxyKeysForFrameRange(manifest, [0, 89])).toEqual([first.source.proxy_key]);
    expect(requiredProxyKeysForFrameRange(manifest, [89, 90])).toEqual([
      first.source.proxy_key,
      second.source.proxy_key,
    ]);
    expect(requiredProxyKeysForFrameRange(manifest, [90, 179])).toEqual([second.source.proxy_key]);
  });
});

describe('bounded operational frame ranges', () => {
  it('selects exactly the frame 2479 regression window', () => {
    expect(boundedFrameRange(26290, 2479, 60, 60)).toEqual([2419, 2539]);
  });
  it('rejects full renders, oversized windows and invalid coordinates', () => {
    expect(() => boundedFrameRange(121, 60, 60, 60)).toThrow();
    expect(() => boundedFrameRange(26290, 2479, 200, 200)).toThrow();
    expect(() => boundedFrameRange(26290, 26290, 60, 60)).toThrow();
    expect(() => boundedFrameRange(26290, -1, 60, 60)).toThrow();
    expect(() => boundedFrameRange(26290, 2479, -1, 60)).toThrow();
  });
});
