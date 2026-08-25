import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    expect(rational(video.avg_frame_rate)).toBe(30);
    expect(probe.streams.filter((item) => item.codec_type === 'audio')).toHaveLength(0);
    expect(rgb[2]!).toBeGreaterThan(rgb[0]! + 50);

    await writeFile(prepared.path, 'corrupt');
    expect((await preparer.prepare(source, placement)).cacheHit).toBe(false);
  }, 30_000);
});
