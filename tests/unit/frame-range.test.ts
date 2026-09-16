import { describe, expect, it } from 'vitest';

import { requiredProxyKeysForFrameRange } from '../../src/domain/frame-range.js';
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
