import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprint } from '../../src/core/identity.js';
import { probeMedia, rational } from '../../src/media/probe.js';
import { ClipSourceAudioProxyPreparer } from '../../src/media/clip-source-audio-proxy.js';
import { runProcess } from '../../src/media/process.js';
import type { ClipRenderManifest } from '../../src/domain/clip-manifest.js';
import { CLIP_PROXY_STRATEGY_V1 } from '../../src/domain/clip-manifest.js';
import type { AppConfig } from '../../src/core/config.js';

const testConfig = (root: string): Partial<AppConfig> => ({
  proxyCacheRoot: path.join(root, 'cache', 'proxies'),
  ffmpegBinary: 'ffmpeg',
  ffprobeBinary: 'ffprobe',
});

const buildManifest = (proxyKey: string, startUs: number, endUs: number): ClipRenderManifest => ({
  schema_version: 'clip_render_manifest_v1',
  composer_strategy_version: 'video_composer_clip_v1',
  proxy_strategy_version: CLIP_PROXY_STRATEGY_V1,
  clip_composition_id: '10000000-0000-4000-8000-000000000001',
  clip_composition_fingerprint: 'a'.repeat(64),
  composition_version: 2,
  workflow_id: '20000000-0000-4000-8000-000000000001',
  source_id: '30000000-0000-4000-8000-000000000001',
  plan_id: '40000000-0000-4000-8000-000000000001',
  candidate_id: '50000000-0000-4000-8000-000000000001',
  analysis_id: null,
  media_id: '70000000-0000-4000-8000-000000000001',
  transcription_id: '80000000-0000-4000-8000-000000000001',
  source_sha256: 'b'.repeat(64),
  source_start_microseconds: startUs,
  source_end_microseconds: endUs,
  duration_microseconds: endUs - startUs,
  duration_seconds: (endUs - startUs) / 1_000_000,
  duration_in_frames: Math.ceil(((endUs - startUs) * 30) / 1_000_000),
  strategy: 'USE_DIRECTLY',
  render_profile: {
    name: 'vertical_short_v1',
    identity: 'test',
    width: 1080,
    height: 1920,
    fps: 30,
    layout_intent: 'portrait_blur_background',
  },
  audio_mode: 'original',
  caption_mode: 'none',
  source_asset: {
    media_id: '70000000-0000-4000-8000-000000000001',
    sha256: 'b'.repeat(64),
    byte_size: 1234,
    content_type: 'video/mp4',
  },
  proxy: {
    proxy_key: proxyKey,
    proxy_url: `http://test/internal-assets/clip-proxy/${proxyKey}`,
    source_start_microseconds: startUs,
    source_end_microseconds: endUs,
    audio_semantics: 'source_audio',
  },
});

describe('clip source-audio proxy integration', () => {
  it('creates exact trim with H.264, 30fps, AAC audio, and preserves source audio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-clip-proxy-'));
    const config = testConfig(root);
    const source = path.join(root, 'source.mp4');

    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:s=320x180:r=30:d=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=4',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-b:a',
        '192k',
        '-shortest',
        '-y',
        source,
      ],
      'fixture_generation',
    );

    const proxyKey = fingerprint({
      strategy: CLIP_PROXY_STRATEGY_V1,
      source_sha256: 'b'.repeat(64),
      source_start_microseconds: '1000000',
      source_end_microseconds: '3000000',
      fps: 30,
      codec: 'h264',
      pixel_format: 'yuv420p',
      audio_semantics: 'source_audio',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
    });

    const manifest = buildManifest(proxyKey, 1_000_000, 3_000_000);
    const preparer = new ClipSourceAudioProxyPreparer(config as AppConfig);

    const prepared = await preparer.prepare(source, manifest);
    const repeated = await preparer.prepare(source, manifest);
    const probe = await probeMedia('ffprobe', prepared.path);
    const video = probe.streams.find((item) => item.codec_type === 'video')!;
    const audio = probe.streams.find((item) => item.codec_type === 'audio')!;

    expect(prepared.cacheHit).toBe(false);
    expect(repeated.cacheHit).toBe(true);
    expect(video.codec_name).toBe('h264');
    expect(video.pix_fmt).toBe('yuv420p');
    expect(rational(video.avg_frame_rate)).toBe(30);
    expect(audio.codec_name).toBe('aac');
    expect(Number(audio.sample_rate)).toBe(48000);

    const expectedDuration = (3_000_000 - 1_000_000) / 1_000_000;
    const actualDuration = probe.format?.duration ? parseFloat(probe.format.duration) : 0;
    expect(Math.abs(actualDuration - expectedDuration)).toBeLessThan(0.1);
  }, 30_000);
});
