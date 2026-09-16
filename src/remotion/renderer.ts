import path from 'node:path';

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import type { RenderManifest } from '../domain/contracts.js';

export interface RenderProgress {
  renderedFrames: number;
  encodedFrames: number;
  renderedDoneIn: number | null;
  encodedDoneIn: number | null;
  stitchStage: 'encoding' | 'muxing';
  progress: number;
}

export interface RenderContext {
  renderId: string;
  frameRange?: [number, number];
  proxyMetadata?: Record<string, { durationSeconds: number; width: number; height: number }>;
}

export interface VideoRenderer {
  initialize(): Promise<void>;
  render(
    manifest: RenderManifest,
    outputPath: string,
    onProgress: (progress: RenderProgress) => void,
    context?: RenderContext,
  ): Promise<void>;
}

const sanitizeDiagnostic = (value: string): string =>
  value
    .replace(/\b(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/giu, '$1[redacted]@')
    .replace(
      /([?&](?:access_token|api_key|key|secret|signature|token)=)[^\s&#]*/giu,
      '$1[redacted]',
    )
    .slice(0, 16_384);

export class RemotionVideoRenderer implements VideoRenderer {
  private serveUrl: string | null = null;

  constructor(private readonly config: AppConfig) {}

  async initialize(): Promise<void> {
    try {
      this.serveUrl = await bundle({
        entryPoint: path.resolve('src/remotion/index.ts'),
        onProgress: () => undefined,
        webpackOverride: (currentConfiguration) => ({
          ...currentConfiguration,
          resolve: {
            ...currentConfiguration.resolve,
            extensionAlias: {
              ...currentConfiguration.resolve?.extensionAlias,
              '.js': ['.ts', '.tsx', '.js'],
            },
          },
        }),
      });
    } catch {
      throw new ComposerError('remotion_initialization_failure', 'Remotion bundle failed');
    }
  }

  async render(
    manifest: RenderManifest,
    outputPath: string,
    onProgress: (progress: RenderProgress) => void,
    context?: RenderContext,
  ): Promise<void> {
    if (!this.serveUrl) throw new ComposerError('renderer_unavailable', 'Renderer is not ready');
    let renderPhase: 'select_composition' | 'render_media' = 'select_composition';
    try {
      const composition = await selectComposition({
        serveUrl: this.serveUrl,
        id: 'NarratedGameplayComposition',
        inputProps: manifest,
        logLevel: 'warn',
      });
      renderPhase = 'render_media';
      await renderMedia({
        serveUrl: this.serveUrl,
        composition,
        inputProps: manifest,
        codec: 'h264',
        audioCodec: null,
        audioBitrate: '192k',
        sampleRate: 48000,
        crf: 18,
        x264Preset: 'fast',
        pixelFormat: 'yuv420p',
        imageFormat: 'png',
        colorSpace: 'bt709',
        outputLocation: outputPath,
        overwrite: true,
        enforceAudioTrack: false,
        muted: true,
        concurrency: this.config.remotionConcurrency,
        frameRange: context?.frameRange ?? null,
        mediaCacheSizeInBytes: this.config.remotionMediaCacheBytes,
        offthreadVideoCacheSizeInBytes: this.config.remotionOffthreadVideoCacheBytes,
        offthreadVideoThreads: this.config.remotionOffthreadVideoThreads,
        logLevel: 'warn',
        ffmpegOverride: ({ type, args }) => {
          if (type !== 'stitcher') return args;
          const output = args.at(-1);
          if (!output) return args;
          return [
            ...args.slice(0, -1),
            '-t',
            manifest.duration_seconds.toFixed(6),
            '-pix_fmt',
            'yuv420p',
            output,
          ];
        },
        onProgress: (value) =>
          onProgress({
            renderedFrames: value.renderedFrames,
            encodedFrames: value.encodedFrames,
            renderedDoneIn: value.renderedDoneIn,
            encodedDoneIn: value.encodedDoneIn,
            stitchStage: value.stitchStage,
            progress: value.progress,
          }),
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : typeof error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'remotion_render_failed',
          render_id: context?.renderId ?? null,
          workflow_id: manifest.workflow_id,
          manifest_schema_version: manifest.schema_version,
          composer_strategy_version: manifest.composer_strategy_version,
          render_phase: renderPhase,
          error_type: sanitizeDiagnostic(errorType),
          error_message: sanitizeDiagnostic(errorMessage),
          error_stack: errorStack ? sanitizeDiagnostic(errorStack) : null,
        }),
      );
      const targetFrame = Number(/\bframe\s*(?:=|:)?\s*(\d+)/iu.exec(errorMessage)?.[1]);
      const placement = Number.isInteger(targetFrame)
        ? manifest.placements.find(
            (item) =>
              targetFrame >= item.frame_start &&
              targetFrame < item.frame_start + item.frame_duration,
          )
        : undefined;
      const videoSource =
        placement?.source && 'proxy_key' in placement.source ? placement.source : null;
      const proxy = videoSource ? context?.proxyMetadata?.[videoSource.proxy_key] : undefined;
      throw new ComposerError('remotion_render_failure', 'Remotion render failed', 500, {
        cause: error,
        diagnostics: {
          target_frame: Number.isInteger(targetFrame) ? targetFrame : null,
          target_timeline_seconds: Number.isInteger(targetFrame)
            ? targetFrame / manifest.render_profile.fps
            : null,
          placement_id: placement?.id,
          placement_order: placement?.order,
          media_id: videoSource?.media_id,
          source_sha256: videoSource?.sha256,
          proxy_key: videoSource?.proxy_key,
          placement_local_frame:
            placement && Number.isInteger(targetFrame) ? targetFrame - placement.frame_start : null,
          placement_local_seconds:
            placement && Number.isInteger(targetFrame)
              ? (targetFrame - placement.frame_start) / manifest.render_profile.fps
              : null,
          proxy_duration_seconds: proxy?.durationSeconds,
          proxy_width: proxy?.width,
          proxy_height: proxy?.height,
          proxy_codec: videoSource ? 'h264' : null,
          renderer_phase: renderPhase,
        },
      });
    }
  }
}
