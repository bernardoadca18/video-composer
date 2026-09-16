import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import { sha256File } from '../core/identity.js';
import type { RenderManifest } from '../domain/contracts.js';
import { proxyProfileForRender, proxyScaleFilter } from '../domain/proxy-profile.js';
import { withFileLock } from '../storage/atomic-cache.js';
import type { CacheCatalog } from '../storage/cache-catalog.js';
import { mediaDuration, probeMediaFast, rational } from './probe.js';
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

type ProxyRenderProfile = RenderManifest['render_profile'];

const defaultRenderProfile: Pick<ProxyRenderProfile, 'width' | 'height' | 'fps'> = {
  width: 1920,
  height: 1080,
  fps: 30,
};

export class ClipProxyPreparer {
  constructor(
    private readonly config: AppConfig,
    private readonly catalog?: CacheCatalog,
  ) {}

  private async validate(
    target: string,
    placement: ProxyPlacement,
    renderProfile: Pick<ProxyRenderProfile, 'width' | 'height' | 'fps'>,
    updateCatalog = true,
  ): Promise<PreparedProxy> {
    const profile = proxyProfileForRender(renderProfile);
    const probe = await probeMediaFast(this.config.ffprobeBinary, target);
    const video = probe.streams.filter((item) => item.codec_type === 'video');
    const unexpectedStreams = probe.streams.filter((item) => item.codec_type !== 'video');
    const duration = mediaDuration(probe);
    const expected =
      ((placement.source.derivative_source_end_microseconds ??
        placement.source.source_end_microseconds) -
        (placement.source.derivative_source_start_microseconds ??
          placement.source.source_start_microseconds)) /
      1_000_000;
    const fps = rational(video[0]?.avg_frame_rate ?? video[0]?.r_frame_rate);
    if (
      video.length !== 1 ||
      unexpectedStreams.length !== 0 ||
      video[0]?.codec_name !== 'h264' ||
      video[0]?.pix_fmt !== 'yuv420p' ||
      !video[0].width ||
      !video[0].height ||
      video[0].width > profile.maxWidth ||
      video[0].height > profile.maxHeight ||
      fps === null ||
      Math.abs(fps - profile.fps) > 0.01 ||
      duration === null ||
      Math.abs(duration - expected) > 1 / profile.fps + 0.005 ||
      (placement.source.proxy_profile_identity !== undefined &&
        placement.source.proxy_profile_identity !== profile.identity)
    ) {
      throw new ComposerError('proxy_validation_failure', 'Clip proxy is invalid');
    }
    if (updateCatalog && this.catalog && !this.catalog.isProxyHotValid(target, profile.identity)) {
      const sha256 = await sha256File(target);
      const details = await stat(target);
      this.catalog.record({
        cacheKey: target,
        cacheKind: 'proxy',
        sha256,
        byteSize: details.size,
        profileIdentity: profile.identity,
      });
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

  async inspectCache(
    placement: ProxyPlacement,
    renderProfile: Pick<ProxyRenderProfile, 'width' | 'height' | 'fps'> = defaultRenderProfile,
  ): Promise<PreparedProxy | null> {
    const target = path.join(this.config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    try {
      const cached = await this.validate(target, placement, renderProfile);
      return { ...cached, cacheHit: true };
    } catch {
      return null;
    }
  }

  async prepare(
    sourcePath: string,
    placement: ProxyPlacement,
    renderProfile: Pick<ProxyRenderProfile, 'width' | 'height' | 'fps'> = defaultRenderProfile,
  ): Promise<PreparedProxy> {
    const target = path.join(this.config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    return await withFileLock(`${target}.lock`, async () => {
      try {
        const cached = await this.validate(target, placement, renderProfile);
        return { ...cached, cacheHit: true };
      } catch {
        await unlink(target).catch(() => undefined);
      }
      await mkdir(this.config.proxyCacheRoot, { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp.mp4`;
      const profile = proxyProfileForRender(renderProfile);
      const sourceStart =
        placement.source.derivative_source_start_microseconds ??
        placement.source.source_start_microseconds;
      const sourceEnd =
        placement.source.derivative_source_end_microseconds ??
        placement.source.source_end_microseconds;
      const duration = sourceEnd - sourceStart;
      try {
        await runProcess(
          this.config.ffmpegBinary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            seconds(sourceStart),
            '-i',
            sourcePath,
            '-t',
            seconds(duration),
            '-map',
            '0:v:0',
            '-vf',
            `setpts=PTS-STARTPTS,fps=${profile.fps},${proxyScaleFilter(profile)}`,
            '-an',
            '-sn',
            '-dn',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-c:v',
            profile.encoderBackend,
            '-preset',
            profile.preset,
            '-crf',
            String(profile.crf),
            '-pix_fmt',
            profile.pixelFormat,
            '-g',
            String(profile.gopFrames),
            '-keyint_min',
            String(profile.gopFrames),
            '-sc_threshold',
            '0',
            '-movflags',
            '+faststart',
            '-y',
            temporary,
          ],
          'proxy_generation_failure',
        );
        const validated = await this.validate(temporary, placement, renderProfile, false);
        await rename(temporary, target);
        if (this.catalog) {
          this.catalog.record({
            cacheKey: target,
            cacheKind: 'proxy',
            sha256: await sha256File(target),
            byteSize: (await stat(target)).size,
            profileIdentity: profile.identity,
          });
        }
        return { ...validated, path: target, cacheHit: false };
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }
}
