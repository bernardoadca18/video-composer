import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { MediaIndexerClient } from '../../src/clients/media-indexer.js';
import { ComposerError } from '../../src/core/errors.js';
import { TemporalDerivativeResolver } from '../../src/services/temporal-derivative-resolver.js';
import { renderManifest, testConfig } from '../helpers.js';

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

describe('temporal derivative resolver', () => {
  it('streams only derivative bytes for a tiny window from a large represented source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-derivative-'));
    const config = testConfig(root);
    const placement = renderManifest(root).placements[0]!;
    const content = Buffer.alloc(1_024, 7);
    const sourceBytes = 10 * 1024 * 1024 * 1024;
    const openContent = vi.fn();
    const openTemporalDerivative = vi.fn(
      async () => new Response(content, { headers: { 'content-length': String(content.length) } }),
    );
    const client = {
      ensureTemporalDerivative: async () => ({
        derivative: {
          id: '90000000-0000-4000-8000-000000000001',
          identity: placement.source.proxy_key,
          source_media_id: placement.source.media_id,
          source_sha256: placement.source.sha256,
          source_start_microseconds: placement.source.derivative_source_start_microseconds!,
          source_end_microseconds: placement.source.derivative_source_end_microseconds!,
          profile_id: 'render_proxy_1080p30_v2',
          profile_identity: placement.source.proxy_profile_identity!,
          strategy_version: 'proxy_strategy_v2',
          status: 'completed' as const,
          sha256: sha256(content),
          byte_size: content.length,
          duration_seconds: 3,
          width: 1920,
          height: 1080,
          fps: 30,
          codec: 'h264',
          generation_seconds: 0.1,
          error: null,
          content_url: '/temporal-derivatives/id/content',
        },
        created: true,
        reusedCompleted: false,
      }),
      openTemporalDerivative,
      openContent,
    } as unknown as MediaIndexerClient;
    const resolver = new TemporalDerivativeResolver(config, client);
    const ensured = await resolver.ensure(
      {
        media_id: placement.source.media_id,
        sha256: placement.source.sha256,
        byte_size: sourceBytes,
      },
      placement,
      renderManifest(root).render_profile,
    );
    const materialized = await resolver.materialize(ensured, placement);

    expect(materialized.byteSize).toBe(content.length);
    expect(materialized.byteSize).toBeLessThan(sourceBytes);
    expect(await readFile(materialized.path)).toEqual(content);
    expect(openTemporalDerivative).toHaveBeenCalledOnce();
    expect(openContent).not.toHaveBeenCalled();
  });

  it.each([
    ['sha mismatch', Buffer.from('wrong'), 5, 'f'.repeat(64)],
    ['size mismatch', Buffer.from('short'), 100, sha256(Buffer.from('short'))],
  ])('rejects %s and removes partial cache state', async (_label, content, size, expectedSha) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-derivative-invalid-'));
    const config = testConfig(root);
    const placement = renderManifest(root).placements[0]!;
    const derivative = {
      id: '90000000-0000-4000-8000-000000000001',
      identity: placement.source.proxy_key,
      source_media_id: placement.source.media_id,
      source_sha256: placement.source.sha256,
      source_start_microseconds: placement.source.derivative_source_start_microseconds!,
      source_end_microseconds: placement.source.derivative_source_end_microseconds!,
      profile_id: 'render_proxy_1080p30_v2',
      profile_identity: placement.source.proxy_profile_identity!,
      strategy_version: 'proxy_strategy_v2',
      status: 'completed' as const,
      sha256: expectedSha,
      byte_size: size,
      duration_seconds: 3,
      width: 1920,
      height: 1080,
      fps: 30,
      codec: 'h264',
      generation_seconds: 0.1,
      error: null,
      content_url: '/temporal-derivatives/id/content',
    };
    const client = {
      openTemporalDerivative: async () =>
        new Response(content, { headers: { 'content-length': String(content.length) } }),
    } as unknown as MediaIndexerClient;
    const resolver = new TemporalDerivativeResolver(config, client);

    await expect(
      resolver.materialize(
        { derivative, created: true, cacheHit: false, waitSeconds: 0 },
        placement,
      ),
    ).rejects.toBeInstanceOf(ComposerError);
    await expect(readdir(config.proxyCacheRoot)).resolves.toEqual([]);
  });
});
