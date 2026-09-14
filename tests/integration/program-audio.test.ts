import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { fingerprint, sha256File } from '../../src/core/identity.js';
import { AudioMixPlanSchema } from '../../src/domain/contracts.js';
import { ProgramAudioProcessor } from '../../src/media/program-audio.js';
import { runProcess } from '../../src/media/process.js';
import { testConfig } from '../helpers.js';
import { audioPlan } from '../unit/program-audio-contract.test.js';

const differentialMeanVolume = async (
  filePath: string,
  start: number,
  duration: number,
): Promise<number> => {
  const result = await runProcess(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-ss',
      String(start),
      '-t',
      String(duration),
      '-i',
      filePath,
      '-af',
      'pan=mono|c0=c0-c1,volumedetect',
      '-f',
      'null',
      '-',
    ],
    'analysis',
  );
  const match = /mean_volume:\s*(-?[0-9.]+) dB/.exec(result.stderr);
  if (!match) throw new Error('mean volume unavailable');
  return Number(match[1]);
};

describe('Program Audio FFmpeg execution', () => {
  it('mixes, ducks, masters and reuses integrity-checked PCM caches', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'program-audio-'));
    const config = testConfig(root);
    const narration = path.join(root, 'narration.wav');
    const music = path.join(root, 'music.wav');
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=if(between(t\\,0.5\\,2)+between(t\\,4\\,5)\\,0.18*sin(2*PI*440*t)\\,0):s=48000:d=6',
        '-ac',
        '1',
        '-c:a',
        'pcm_s24le',
        '-y',
        narration,
      ],
      'fixture',
    );
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=0.12*sin(2*PI*220*t)|0.12*sin(2*PI*330*t):s=48000:d=6',
        '-c:a',
        'pcm_s24le',
        '-y',
        music,
      ],
      'fixture',
    );
    const base = audioPlan();
    if (!base.music.enabled) throw new Error('fixture');
    const musicDetails = await stat(music);
    const content = {
      ...base,
      narration: { ...base.narration, sha256: await sha256File(narration) },
      music: {
        ...base.music,
        asset: {
          ...base.music.asset,
          sha256: await sha256File(music),
          byte_size: musicDetails.size,
        },
      },
      ducking: {
        ...base.ducking,
        speech_regions: [
          { start_seconds: 0.5, end_seconds: 2 },
          { start_seconds: 4, end_seconds: 5 },
        ],
      },
    };
    const { fingerprint: ignored, ...withoutFingerprint } = content;
    void ignored;
    const plan = AudioMixPlanSchema.parse({
      ...withoutFingerprint,
      fingerprint: fingerprint(withoutFingerprint),
    });
    const manifest = { audio_mix_plan: plan } as never;
    const processor = new ProgramAudioProcessor(config);
    const first = await processor.prepare(manifest, narration, {
      path: music,
      cacheHit: false,
      byteSize: musicDetails.size,
      sha256: plan.music.enabled ? plan.music.asset.sha256 : '',
    });
    expect(first.mixCacheHit).toBe(false);
    expect(first.masterCacheHit).toBe(false);
    expect(first.after.integratedLufs).toBeCloseTo(-14, 0);
    expect(first.after.truePeakDbtp).toBeLessThanOrEqual(-0.9);
    const speech = await differentialMeanVolume(first.mixPath, 1.0, 0.7);
    const pause = await differentialMeanVolume(first.mixPath, 2.8, 0.7);
    expect(pause - speech).toBeGreaterThan(7);

    const second = await processor.prepare(manifest, narration, {
      path: music,
      cacheHit: true,
      byteSize: musicDetails.size,
      sha256: plan.music.enabled ? plan.music.asset.sha256 : '',
    });
    expect(second.normalizedMusicCacheHit).toBe(true);
    expect(second.mixCacheHit).toBe(true);
    expect(second.masterCacheHit).toBe(true);
    expect(second.mixSha256).toBe(first.mixSha256);
    expect(second.masterSha256).toBe(first.masterSha256);
  }, 30_000);
});
