import path from 'node:path';

import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import type { RenderManifest } from '../domain/contracts.js';

export interface RenderProgress {
  renderedFrames: number;
  encodedFrames: number;
  progress: number;
}

export interface RenderContext {
  renderId: string;
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
        x264Preset: 'medium',
        pixelFormat: 'yuv420p',
        imageFormat: 'png',
        colorSpace: 'bt709',
        outputLocation: outputPath,
        overwrite: true,
        enforceAudioTrack: false,
        muted: true,
        concurrency: this.config.remotionConcurrency,
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
      throw new ComposerError('remotion_render_failure', 'Remotion render failed');
    }
  }
}
