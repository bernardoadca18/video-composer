import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ComposerError, publicError } from '../../src/core/errors.js';
import { fingerprint } from '../../src/core/identity.js';
import { probeMedia, rational } from '../../src/media/probe.js';
import { ClipProxyPreparer } from '../../src/media/proxy.js';
import { runProcess } from '../../src/media/process.js';
import { renderManifest, testConfig } from '../helpers.js';

const pixel = async (filePath: string): Promise<Buffer> =>
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-v',
      'error',
      '-ss',
      '0.5',
      '-i',
      filePath,
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('pixel extraction failed')),
    );
  });

describe('clip proxy integration', () => {
  it('uses an accurate trim, fixed FPS, H.264 and removes gameplay audio', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-proxy-'));
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
        'color=c=red:s=320x180:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=320x180:r=30:d=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000:duration=4',
        '-filter_complex',
        '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map',
        '[v]',
        '-map',
        '2:a:0',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        '-y',
        source,
      ],
      'fixture_generation',
    );
    const manifest = renderManifest(root);
    const placement = manifest.placements[0]!;
    placement.frame_duration = 60;
    placement.source.source_start_microseconds = 2_000_000;
    placement.source.source_end_microseconds = 4_000_000;
    placement.source.derivative_source_start_microseconds = 2_000_000;
    placement.source.derivative_source_end_microseconds = 4_000_000;
    placement.source.proxy_trim_start_microseconds = 0;
    placement.source.proxy_trim_end_microseconds = 2_000_000;
    placement.source.proxy_trim_start_frame = 0;
    delete placement.source.proxy_profile_identity;
    placement.source.proxy_key = fingerprint({ source: 'blue-trim' });
    const preparer = new ClipProxyPreparer(config);

    const prepared = await preparer.prepare(source, placement);
    const repeated = await preparer.prepare(source, placement);
    const probe = await probeMedia('ffprobe', prepared.path);
    const video = probe.streams.find((item) => item.codec_type === 'video')!;
    const rgb = await pixel(prepared.path);

    expect(prepared.cacheHit).toBe(false);
    expect(repeated.cacheHit).toBe(true);
    expect(video.codec_name).toBe('h264');
    expect(video.pix_fmt).toBe('yuv420p');
    expect(video.width).toBe(320);
    expect(video.height).toBe(180);
    expect(rational(video.avg_frame_rate)).toBe(30);
    expect(probe.streams.filter((item) => item.codec_type === 'audio')).toHaveLength(0);
    expect(probe.streams).toHaveLength(1);
    expect(rgb[2]!).toBeGreaterThan(rgb[0]! + 50);

    await writeFile(prepared.path, 'corrupt');
    expect((await preparer.prepare(source, placement)).cacheHit).toBe(false);
  }, 30_000);

  it('caps a 4K source at the render profile dimensions without upscaling smaller inputs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-proxy-4k-'));
    const config = testConfig(root);
    const source = path.join(root, 'source-4k.mp4');
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=3840x2160:r=30:d=1',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-y',
        source,
      ],
      'fixture_generation',
    );
    const placement = renderManifest(root).placements[0]!;
    placement.frame_duration = 30;
    placement.source.source_start_microseconds = 0;
    placement.source.source_end_microseconds = 1_000_000;
    placement.source.derivative_source_start_microseconds = 0;
    placement.source.derivative_source_end_microseconds = 1_000_000;
    placement.source.proxy_trim_start_microseconds = 0;
    placement.source.proxy_trim_end_microseconds = 1_000_000;
    placement.source.proxy_trim_start_frame = 0;
    delete placement.source.proxy_profile_identity;
    placement.source.proxy_key = fingerprint({ source: '4k-trim' });

    const prepared = await new ClipProxyPreparer(config).prepare(source, placement);
    expect(prepared.width).toBeLessThanOrEqual(1920);
    expect(prepared.height).toBeLessThanOrEqual(1080);
    expect(prepared.width).toBe(1920);
    expect(prepared.height).toBe(1080);
  }, 60_000);
});

describe('full-range derivative regression', () => {
  it('accepts the 34.79s incident range encoded as 1044 full-range 8-bit 420 frames', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-full-range-'));
    const config = testConfig(root);
    await mkdir(config.proxyCacheRoot, { recursive: true });
    const placement = renderManifest(root).placements[0]!;
    Object.assign(placement.source, {
      source_start_microseconds: 354351000,
      source_end_microseconds: 379541000,
      derivative_source_start_microseconds: 349551000,
      derivative_source_end_microseconds: 384341000,
      proxy_trim_start_frame: 144,
    });
    const target = path.join(config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x36:r=30:d=34.8',
        '-vf',
        'setparams=range=full:colorspace=bt709:color_primaries=bt709:color_trc=bt709',
        '-an',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-y',
        target,
      ],
      'fixture_generation',
    );
    const probe = await probeMedia('ffprobe', target);
    expect(probe.streams[0]?.pix_fmt).toBe('yuvj420p');
    expect(probe.streams[0]?.nb_frames).toBe('1044');
    expect(await new ClipProxyPreparer(config).inspectCache(placement)).not.toBeNull();
  });
});

describe('private proxy rejection diagnostics', () => {
  it('logs the exact predicate for a real 444 proxy but keeps cold misses quiet and public errors sanitized', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-invalid-format-'));
    const config = testConfig(root);
    const placement = renderManifest(root).placements[0]!;
    Object.assign(placement.source, {
      derivative_source_start_microseconds: 0,
      derivative_source_end_microseconds: 1000000,
    });
    const preparer = new ClipProxyPreparer(config);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await preparer.inspectCache(placement)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      await mkdir(config.proxyCacheRoot, { recursive: true });
      const target = path.join(config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
      await runProcess(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=64x36:r=30:d=1',
          '-an',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv444p',
          '-color_range',
          'pc',
          '-y',
          target,
        ],
        'fixture_generation',
      );
      let rejected: unknown;
      try {
        await preparer.inspectCache(placement, undefined, {
          renderId: 'render-under-test',
          derivativeId: 'derivative-under-test',
          required: true,
        });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(ComposerError);
      const diagnostic = (rejected as ComposerError).diagnostics;
      expect(diagnostic).toMatchObject({
        rejection_predicates: 'pixel_format',
        render_id: 'render-under-test',
        derivative_id: 'derivative-under-test',
        placement_id: placement.id,
        proxy_key: placement.source.proxy_key,
        media_id: placement.source.media_id,
        source_sha256: placement.source.sha256,
        expected_duration_seconds: 1,
        actual_duration_seconds: 1,
        expected_fps: 30,
        actual_fps: 30,
        expected_pixel_format: 'yuv420p',
        actual_pixel_format: 'yuvj444p',
        actual_codec: 'h264',
        actual_width: 64,
        actual_height: 36,
        video_stream_count: 1,
        unexpected_stream_count: 0,
        expected_profile_identity: placement.source.proxy_profile_identity,
        actual_profile_identity: placement.source.proxy_profile_identity,
      });
      expect(JSON.parse(warn.mock.calls[0]![0] as string)).toMatchObject({
        event: 'proxy_cache_invalid',
        ...diagnostic,
      });
      expect(publicError(rejected)).toEqual({
        category: 'proxy_validation_failure',
        message: 'Downloaded temporal derivative is invalid',
        status: 500,
      });
      expect(JSON.stringify(publicError(rejected))).not.toContain(root);
    } finally {
      warn.mockRestore();
    }
  });
});
