import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import type { RenderManifest } from '../domain/contracts.js';
import { withFileLock } from '../storage/atomic-cache.js';
import { mediaDuration, probeMedia, rational } from './probe.js';
import { runProcess } from './process.js';

export interface PreparedProxy {
  path: string;
  key: string;
  cacheHit: boolean;
  durationSeconds: number;
  width: number;
  height: number;
}

export type ProxyPlacement = Extract<
  RenderManifest['placements'][number],
  { source: { proxy_key: string } }
>;

const seconds = (microseconds: number): string => (microseconds / 1_000_000).toFixed(6);

export class ClipProxyPreparer {
  constructor(private readonly config: AppConfig) {}

  private async validate(target: string, placement: ProxyPlacement): Promise<PreparedProxy> {
    const probe = await probeMedia(this.config.ffprobeBinary, target);
    const video = probe.streams.filter((item) => item.codec_type === 'video');
    const audio = probe.streams.filter((item) => item.codec_type === 'audio');
    const duration = mediaDuration(probe);
    const expected =
      (placement.source.source_end_microseconds - placement.source.source_start_microseconds) /
      1_000_000;
    const fps = rational(video[0]?.avg_frame_rate ?? video[0]?.r_frame_rate);
    if (
      video.length !== 1 ||
      audio.length !== 0 ||
      video[0]?.codec_name !== 'h264' ||
      video[0]?.pix_fmt !== 'yuv420p' ||
      !video[0].width ||
      !video[0].height ||
      fps === null ||
      Math.abs(fps - placement.frame_duration / expected) > 1 ||
      Math.abs(fps - 30) > 0.01 ||
      duration === null ||
      Math.abs(duration - expected) > 1 / 30 + 0.005
    ) {
      throw new ComposerError('proxy_validation_failure', 'Clip proxy is invalid');
    }
    return {
      path: target,
      key: placement.source.proxy_key,
      cacheHit: false,
      durationSeconds: duration,
      width: video[0].width,
      height: video[0].height,
    };
  }

  async prepare(sourcePath: string, placement: ProxyPlacement): Promise<PreparedProxy> {
    const target = path.join(this.config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    return await withFileLock(`${target}.lock`, async () => {
      try {
        const cached = await this.validate(target, placement);
        return { ...cached, cacheHit: true };
      } catch {
        await unlink(target).catch(() => undefined);
      }
      await mkdir(this.config.proxyCacheRoot, { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp.mp4`;
      const duration =
        placement.source.source_end_microseconds - placement.source.source_start_microseconds;
      try {
        await runProcess(
          this.config.ffmpegBinary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            seconds(placement.source.source_start_microseconds),
            '-i',
            sourcePath,
            '-t',
            seconds(duration),
            '-map',
            '0:v:0',
            '-vf',
            'setpts=PTS-STARTPTS,fps=30',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-y',
            temporary,
          ],
          'proxy_generation_failure',
        );
        const validated = await this.validate(temporary, placement);
        await rename(temporary, target);
        return { ...validated, path: target, cacheHit: false };
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }
}
