import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError, type InternalErrorDiagnostics } from '../core/errors.js';
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
    // FFmpeg reports full-range planar 8-bit 4:2:0 as yuvj420p, including
    // libx264 output requested as yuv420p. Preserve the profile's color passthrough.
    const pixelFormatMatches =
      video[0]?.pix_fmt === profile.pixelFormat ||
      (video[0]?.pix_fmt === 'yuvj420p' && video[0]?.color_range === 'pc');
    const durationTolerance = 1 / profile.fps + 0.005;
    const failures = [
      video.length !== 1 && 'video_stream_count',
      unexpectedStreams.length !== 0 && 'unexpected_stream_count',
      video[0]?.codec_name !== 'h264' && 'codec',
      !pixelFormatMatches && 'pixel_format',
      (!video[0]?.width || video[0].width > profile.maxWidth) && 'width',
      (!video[0]?.height || video[0].height > profile.maxHeight) && 'height',
      (fps === null || Math.abs(fps - profile.fps) > 0.01) && 'fps',
      (duration === null || Math.abs(duration - expected) > durationTolerance) && 'duration',
      placement.source.proxy_profile_identity !== undefined &&
        placement.source.proxy_profile_identity !== profile.identity &&
        'proxy_profile_identity',
    ].filter((value): value is string => typeof value === 'string');
    if (failures.length) {
      throw new ComposerError('proxy_validation_failure', 'Clip proxy is invalid', 500, {
        diagnostics: {
          rejection_predicates: failures.join(','),
          expected_duration_seconds: expected,
          actual_duration_seconds: duration,
          duration_delta_seconds: duration === null ? null : Math.abs(duration - expected),
          duration_tolerance_seconds: durationTolerance,
          expected_fps: profile.fps,
          actual_fps: fps,
          fps_tolerance: 0.01,
          actual_codec: video[0]?.codec_name,
          expected_codec: 'h264',
          actual_pixel_format: video[0]?.pix_fmt,
          expected_pixel_format: profile.pixelFormat,
          actual_color_range: video[0]?.color_range,
          actual_width: video[0]?.width,
          max_width: profile.maxWidth,
          actual_height: video[0]?.height,
          max_height: profile.maxHeight,
          video_stream_count: video.length,
          unexpected_stream_count: unexpectedStreams.length,
          stream_count: probe.streams.length,
          expected_profile_identity: profile.identity,
          actual_profile_identity: placement.source.proxy_profile_identity,
        },
      });
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
      durationSeconds: duration!,
      width: video[0]!.width!,
      height: video[0]!.height!,
    };
  }

  async inspectCache(
    placement: ProxyPlacement,
    renderProfile: Pick<ProxyRenderProfile, 'width' | 'height' | 'fps'> = defaultRenderProfile,
    context: { renderId?: string; derivativeId?: string; required?: boolean } = {},
  ): Promise<PreparedProxy | null> {
    const target = path.join(this.config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    try {
      // Distinguish a normal cold miss from a present but rejected file.
      await stat(target);
      const cached = await this.validate(target, placement, renderProfile);
      return { ...cached, cacheHit: true };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const diagnostics: InternalErrorDiagnostics = {
        render_id: context.renderId,
        derivative_id: context.derivativeId,
        proxy_key: placement.source.proxy_key,
        placement_id: placement.id,
        media_id: placement.source.media_id,
        source_sha256: placement.source.sha256,
        rejection_predicates: missing ? 'cache_file_missing' : 'probe_or_cache_io_failure',
        ...(error instanceof ComposerError ? error.diagnostics : {}),
      };
      if (!missing)
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'proxy_cache_invalid',
            ...diagnostics,
          }),
        );
      if (context.required) {
        throw new ComposerError(
          'proxy_validation_failure',
          'Downloaded temporal derivative is invalid',
          500,
          { cause: error, diagnostics },
        );
      }
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
