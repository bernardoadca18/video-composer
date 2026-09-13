import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError, publicError } from '../core/errors.js';
import { validateNarration, validateStaticImage } from '../media/probe.js';
import { validateOutput } from '../media/output-validator.js';
import type { ClipProxyPreparer, ProxyPlacement } from '../media/proxy.js';
import type { VideoRenderer } from '../remotion/renderer.js';
import type {
  GameplaySourceResolver,
  NarrationAssetResolver,
} from '../services/asset-resolvers.js';
import type { RenderJobRepository } from './repository.js';

export class RenderJobProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: RenderJobRepository,
    private readonly narrationResolver: NarrationAssetResolver,
    private readonly sourceResolver: GameplaySourceResolver,
    private readonly proxyPreparer: ClipProxyPreparer,
    private readonly renderer: VideoRenderer,
  ) {}

  async process(jobId: string): Promise<void> {
    const job = this.repository.get(jobId);
    if (!job) return;
    const totalStarted = performance.now();
    const workDirectory = path.join(this.config.workRoot, job.id);
    const temporaryOutput = path.join(workDirectory, 'output.tmp.mp4');
    const finalOutput = path.join(this.config.outputRoot, `${job.id}.mp4`);
    await mkdir(workDirectory, { recursive: true });
    await mkdir(this.config.outputRoot, { recursive: true });
    await unlink(temporaryOutput).catch(() => undefined);
    try {
      this.repository.updateProgress(job.id, 'preparing_assets', 0.02);
      const preparationStarted = performance.now();
      const narration = await this.narrationResolver.resolve(
        job.workflowId,
        job.manifest.narration.sha256,
        job.manifest.narration.byte_size,
      );
      await validateNarration(
        this.config.ffprobeBinary,
        narration.path,
        job.manifest.duration_seconds,
      );
      const sourcePaths = new Map<string, string>();
      let sourceCacheHits = 0;
      for (const asset of job.manifest.source_assets) {
        const source = await this.sourceResolver.resolve(
          asset.media_id,
          asset.sha256,
          asset.byte_size,
        );
        sourcePaths.set(asset.sha256, source.path);
        if (source.cacheHit) sourceCacheHits += 1;
        if ('media_kind' in asset && asset.media_kind === 'image') {
          await validateStaticImage(this.config.ffprobeBinary, source.path);
        }
      }
      const uniqueProxies = new Map<string, ProxyPlacement>();
      for (const placement of job.manifest.placements) {
        if ('proxy_key' in placement.source) {
          uniqueProxies.set(placement.source.proxy_key, placement as ProxyPlacement);
        }
      }
      let proxyCacheHits = 0;
      for (const placement of uniqueProxies.values()) {
        const sourcePath = sourcePaths.get(placement.source.sha256);
        if (!sourcePath)
          throw new ComposerError('source_asset_missing', 'Prepared source is missing');
        const proxy = await this.proxyPreparer.prepare(sourcePath, placement);
        if (proxy.cacheHit) proxyCacheHits += 1;
      }
      const preparationSeconds = (performance.now() - preparationStarted) / 1000;
      this.repository.updateProgress(job.id, 'rendering', 0.1);
      const renderStarted = performance.now();
      let lastPersisted = -1;
      await this.renderer.render(job.manifest, temporaryOutput, (progress) => {
        const percent = Math.floor(progress.progress * 100);
        if (percent >= lastPersisted + 2 || percent === 100) {
          lastPersisted = percent;
          this.repository.updateProgress(
            job.id,
            'rendering',
            0.1 + progress.progress * 0.8,
            Math.max(progress.renderedFrames, progress.encodedFrames),
          );
        }
      });
      const renderSeconds = (performance.now() - renderStarted) / 1000;
      this.repository.updateProgress(job.id, 'validating', 0.92, job.totalFrames);
      const validationStarted = performance.now();
      const output = await validateOutput(this.config, temporaryOutput, job.manifest);
      const validationSeconds = (performance.now() - validationStarted) / 1000;
      await rename(temporaryOutput, finalOutput);
      const totalSeconds = (performance.now() - totalStarted) / 1000;
      this.repository.complete(
        job.id,
        finalOutput,
        { ...output, mimeType: 'video/mp4', filename: `${job.id}.mp4` },
        {
          preparationSeconds,
          renderSeconds,
          validationSeconds,
          totalSeconds,
          renderFactor: renderSeconds / job.manifest.duration_seconds,
          narrationCacheHit: narration.cacheHit,
          sourceCacheHits,
          sourceAssetCount: job.manifest.source_assets.length,
          proxyCacheHits,
          proxyCount: uniqueProxies.size,
          remotionVersion: '4.0.516',
          composerStrategyVersion: job.manifest.composer_strategy_version,
        },
      );
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'render_completed',
          render_id: job.id,
          workflow_id: job.workflowId,
          render_profile: job.renderProfile,
          duration_seconds: job.manifest.duration_seconds,
          output_sha256: output.sha256,
          total_seconds: totalSeconds,
          render_factor: renderSeconds / job.manifest.duration_seconds,
        }),
      );
    } catch (error) {
      await unlink(temporaryOutput).catch(() => undefined);
      await unlink(finalOutput).catch(() => undefined);
      const safe = publicError(error);
      this.repository.fail(job.id, safe.category, safe.message);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'render_failed',
          render_id: job.id,
          workflow_id: job.workflowId,
          render_profile: job.renderProfile,
          phase: this.repository.get(job.id)?.phase,
          error_category: safe.category,
          error_message: safe.message,
        }),
      );
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
