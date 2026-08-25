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

export interface VideoRenderer {
  initialize(): Promise<void>;
  render(
    manifest: RenderManifest,
    outputPath: string,
    onProgress: (progress: RenderProgress) => void,
  ): Promise<void>;
}

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
  ): Promise<void> {
    if (!this.serveUrl) throw new ComposerError('renderer_unavailable', 'Renderer is not ready');
    try {
      const composition = await selectComposition({
        serveUrl: this.serveUrl,
        id: 'NarratedGameplayComposition',
        inputProps: manifest,
        logLevel: 'warn',
      });
      await renderMedia({
        serveUrl: this.serveUrl,
        composition,
        inputProps: manifest,
        codec: 'h264',
        audioCodec: 'aac',
        audioBitrate: '192k',
        sampleRate: 48000,
        crf: 18,
        x264Preset: 'medium',
        pixelFormat: 'yuv420p',
        imageFormat: 'png',
        colorSpace: 'bt709',
        outputLocation: outputPath,
        overwrite: true,
        enforceAudioTrack: true,
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
    } catch {
      throw new ComposerError('remotion_render_failure', 'Remotion render failed');
    }
  }
}
