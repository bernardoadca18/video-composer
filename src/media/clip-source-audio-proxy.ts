import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import type { ClipRenderManifest } from '../domain/clip-manifest.js';
import { withFileLock } from '../storage/atomic-cache.js';
import { mediaDuration, probeMedia, rational } from './probe.js';
import { runProcess } from './process.js';

export interface PreparedClipProxy {
  path: string;
  key: string;
  cacheHit: boolean;
  durationSeconds: number;
  width: number;
  height: number;
}

const seconds = (microseconds: number): string => (microseconds / 1_000_000).toFixed(6);

export class ClipSourceAudioProxyPreparer {
  constructor(private readonly config: AppConfig) {}

  private async validate(target: string, manifest: ClipRenderManifest): Promise<PreparedClipProxy> {
    const probe = await probeMedia(this.config.ffprobeBinary, target);
    const video = probe.streams.filter((item) => item.codec_type === 'video');
    const audio = probe.streams.filter((item) => item.codec_type === 'audio');
    const duration = mediaDuration(probe);

    const expected =
      (manifest.source_end_microseconds - manifest.source_start_microseconds) / 1_000_000;

    const fps = rational(video[0]?.avg_frame_rate ?? video[0]?.r_frame_rate);

    if (
      video.length !== 1 ||
      audio.length !== 1 ||
      video[0]?.codec_name !== 'h264' ||
      video[0]?.pix_fmt !== 'yuv420p' ||
      !video[0].width ||
      !video[0].height ||
      fps === null ||
      Math.abs(fps - 30) > 0.01 ||
      audio[0]?.codec_name !== 'aac' ||
      Number(audio[0]?.sample_rate) !== 48000 ||
      duration === null ||
      Math.abs(duration - expected) > 1 / 30 + 0.005
    ) {
      throw new ComposerError(
        'clip_proxy_validation_failure',
        'Clip source-audio proxy is invalid',
      );
    }

    return {
      path: target,
      key: manifest.proxy.proxy_key,
      cacheHit: false,
      durationSeconds: duration,
      width: video[0].width,
      height: video[0].height,
    };
  }

  async prepare(sourcePath: string, manifest: ClipRenderManifest): Promise<PreparedClipProxy> {
    const target = path.join(this.config.proxyCacheRoot, `${manifest.proxy.proxy_key}.mp4`);

    return await withFileLock(`${target}.lock`, async () => {
      try {
        const cached = await this.validate(target, manifest);
        return { ...cached, cacheHit: true };
      } catch {
        await unlink(target).catch(() => undefined);
      }

      await mkdir(this.config.proxyCacheRoot, { recursive: true });

      const temporary = `${target}.${randomUUID()}.tmp.mp4`;
      const duration = manifest.source_end_microseconds - manifest.source_start_microseconds;

      try {
        await runProcess(
          this.config.ffmpegBinary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            seconds(manifest.source_start_microseconds),
            '-i',
            sourcePath,
            '-t',
            seconds(duration),
            '-map',
            '0:v:0',
            '-map',
            '0:a:0',
            '-vf',
            'setpts=PTS-STARTPTS,fps=30',
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-ar',
            '48000',
            '-movflags',
            '+faststart',
            '-y',
            temporary,
          ],
          'clip_proxy_generation_failure',
        );

        const validated = await this.validate(temporary, manifest);
        await rename(temporary, target);
        return { ...validated, path: target, cacheHit: false };
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }
}
