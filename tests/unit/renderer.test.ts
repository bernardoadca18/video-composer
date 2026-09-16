import { renderMedia, selectComposition } from '@remotion/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposerError } from '../../src/core/errors.js';
import { RemotionVideoRenderer } from '../../src/remotion/renderer.js';
import { renderManifest, testConfig } from '../helpers.js';

vi.mock('@remotion/bundler', () => ({ bundle: vi.fn(async () => '/controlled-bundle') }));
vi.mock('@remotion/renderer', () => ({
  renderMedia: vi.fn(),
  selectComposition: vi.fn(),
}));

describe('Remotion renderer failure observability', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs the original render error with safe job context and preserves the public error', async () => {
    vi.mocked(selectComposition).mockResolvedValue({} as never);
    vi.mocked(renderMedia).mockRejectedValue(
      new TypeError(
        'render exploded at https://operator:password@example.test/media?token=secret-value',
      ),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const renderer = new RemotionVideoRenderer(testConfig('/tmp/renderer-observability'));
    await renderer.initialize();

    const rendering = renderer.render(
      renderManifest('/tmp/renderer-observability'),
      '/tmp/out.mp4',
      () => undefined,
      {
        renderId: '80000000-0000-4000-8000-000000000008',
      },
    );
    await expect(rendering).rejects.toMatchObject({
      category: 'remotion_render_failure',
      message: 'Remotion render failed',
    } satisfies Partial<ComposerError>);

    const diagnostic = JSON.parse(String(errorLog.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(diagnostic).toMatchObject({
      event: 'remotion_render_failed',
      render_id: '80000000-0000-4000-8000-000000000008',
      workflow_id: renderManifest('/tmp/renderer-observability').workflow_id,
      manifest_schema_version: 'render_manifest_v1',
      composer_strategy_version: 'video_composer_v1',
      render_phase: 'render_media',
      error_type: 'TypeError',
    });
    expect(diagnostic.error_message).toContain('render exploded');
    expect(diagnostic.error_stack).toContain('TypeError: render exploded');
    expect(JSON.stringify(diagnostic)).not.toContain('password');
    expect(JSON.stringify(diagnostic)).not.toContain('secret-value');
  });

  it('enriches a frame failure with the placement and proxy identity', async () => {
    vi.mocked(selectComposition).mockResolvedValue({} as never);
    vi.mocked(renderMedia).mockRejectedValue(new Error('TimeoutError while waiting for frame 90'));
    const renderer = new RemotionVideoRenderer(testConfig('/tmp/renderer-frame-diagnostics'));
    await renderer.initialize();
    const manifest = renderManifest('/tmp/renderer-frame-diagnostics');
    const placement = manifest.placements[1]!;
    await expect(
      renderer.render(manifest, '/tmp/out.mp4', () => undefined, {
        renderId: '80000000-0000-4000-8000-000000000009',
        proxyMetadata: {
          [placement.source.proxy_key]: { durationSeconds: 3, width: 1920, height: 1080 },
        },
      }),
    ).rejects.toMatchObject({
      category: 'remotion_render_failure',
      diagnostics: {
        target_frame: 90,
        placement_id: placement.id,
        placement_order: placement.order,
        media_id: placement.source.media_id,
        proxy_key: placement.source.proxy_key,
        placement_local_frame: 0,
        proxy_width: 1920,
        proxy_height: 1080,
      },
    } satisfies Partial<ComposerError>);
  });
});
