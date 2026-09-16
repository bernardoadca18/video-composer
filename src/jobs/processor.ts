import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../core/config.js';
import { ComposerError, internalError, publicError } from '../core/errors.js';
import { validateMusicAsset, validateNarration, validateStaticImage } from '../media/probe.js';
import type { ProgramAudioResult } from '../media/program-audio.js';
import type { ProgramAudioProcessor } from '../media/program-audio.js';
import { validateOutput } from '../media/output-validator.js';
import type { ClipProxyPreparer, ProxyPlacement } from '../media/proxy.js';
import { intervalUnionMicroseconds } from '../domain/proxy-planner.js';
import type { VideoRenderer } from '../remotion/renderer.js';
import type {
  GameplaySourceResolver,
  MusicAssetResolver,
  NarrationAssetResolver,
} from '../services/asset-resolvers.js';
import type {
  EnsuredTemporalDerivative,
  TemporalDerivativeResolver,
} from '../services/temporal-derivative-resolver.js';
import type { RenderJobRepository } from './repository.js';
import { createDiskPlan, requireDiskCapacity } from '../storage/disk-plan.js';

interface ActivePreparationOperation {
  preparationStep: string;
  sourceKind?: 'narration' | 'gameplay' | 'static_image' | 'music' | 'proxy' | 'derivative';
  mediaId?: string;
  assetId?: string;
  expectedSizeBytes?: number | null;
  startedAt: number;
}

export class RenderJobProcessor {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: RenderJobRepository,
    private readonly narrationResolver: NarrationAssetResolver,
    private readonly sourceResolver: GameplaySourceResolver,
    private readonly musicResolver: MusicAssetResolver,
    private readonly proxyPreparer: ClipProxyPreparer,
    private readonly renderer: VideoRenderer,
    private readonly programAudio: ProgramAudioProcessor,
    private readonly derivativeResolver: TemporalDerivativeResolver | null = null,
  ) {}

  async process(jobId: string): Promise<void> {
    const job = this.repository.get(jobId);
    if (!job) return;
    const totalStarted = performance.now();
    const workDirectory = path.join(this.config.workRoot, job.id);
    const temporaryOutput = path.join(workDirectory, 'output.tmp.mp4');
    const temporaryVideo = path.join(workDirectory, 'video-only.tmp.mp4');
    const finalOutput = path.join(this.config.outputRoot, `${job.id}.mp4`);
    let activePreparation: ActivePreparationOperation | null = null;
    await mkdir(workDirectory, { recursive: true });
    await mkdir(this.config.outputRoot, { recursive: true });
    await unlink(temporaryOutput).catch(() => undefined);
    try {
      this.repository.updateProgress(job.id, 'preparing_assets', 0.02);
      const preparationStarted = performance.now();
      activePreparation = {
        preparationStep: 'materializing_narration',
        sourceKind: 'narration',
        expectedSizeBytes: job.manifest.narration.byte_size,
        startedAt: performance.now(),
      };
      const narration = await this.narrationResolver.resolve(
        job.workflowId,
        job.manifest.narration.sha256,
        job.manifest.narration.byte_size,
      );
      activePreparation = {
        preparationStep: 'validating_narration',
        sourceKind: 'narration',
        expectedSizeBytes: job.manifest.narration.byte_size,
        startedAt: performance.now(),
      };
      await validateNarration(
        this.config.ffprobeBinary,
        narration.path,
        job.manifest.duration_seconds,
      );
      let programAudioResult: ProgramAudioResult | null = null;
      let musicCacheHit: boolean | null = null;
      if (job.manifest.schema_version === 'render_manifest_v4') {
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'program_mix_started',
            render_id: job.id,
            audio_mix_plan_fingerprint: job.manifest.audio_mix_plan.fingerprint,
          }),
        );
        let music = null;
        if (job.manifest.audio_mix_plan.music.enabled) {
          const asset = job.manifest.audio_mix_plan.music.asset;
          activePreparation = {
            preparationStep: 'materializing_music',
            sourceKind: 'music',
            assetId: asset.asset_id,
            expectedSizeBytes: asset.byte_size,
            startedAt: performance.now(),
          };
          music = await this.musicResolver.resolve(
            job.workflowId,
            asset.asset_id,
            asset.sha256,
            asset.byte_size,
            asset.format,
          );
          musicCacheHit = music.cacheHit;
          activePreparation = {
            preparationStep: 'validating_music',
            sourceKind: 'music',
            assetId: asset.asset_id,
            expectedSizeBytes: asset.byte_size,
            startedAt: performance.now(),
          };
          await validateMusicAsset(this.config.ffprobeBinary, music.path, {
            durationSeconds: asset.duration_seconds,
            sampleRate: asset.sample_rate,
            channels: asset.channels,
            format: asset.format,
          });
          console.info(
            JSON.stringify({
              level: 'info',
              event: 'music_materialized',
              render_id: job.id,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
              cache_hit: music.cacheHit,
            }),
          );
        }
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'program_master_started',
            render_id: job.id,
            profile_id: job.manifest.audio_mix_plan.program_master.profile_id,
          }),
        );
        activePreparation = {
          preparationStep: 'preparing_program_audio',
          sourceKind: 'narration',
          startedAt: performance.now(),
        };
        programAudioResult = await this.programAudio.prepare(job.manifest, narration.path, music);
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'program_mix_completed',
            render_id: job.id,
            audio_mix_plan_fingerprint: job.manifest.audio_mix_plan.fingerprint,
            mix_sha256: programAudioResult.mixSha256,
            master_sha256: programAudioResult.masterSha256,
          }),
        );
        console.info(
          JSON.stringify({
            level: 'info',
            event: 'program_master_completed',
            render_id: job.id,
            master_sha256: programAudioResult.masterSha256,
            integrated_lufs: programAudioResult.after.integratedLufs,
            true_peak_dbtp: programAudioResult.after.truePeakDbtp,
          }),
        );
      }
      const uniqueProxies = new Map<string, ProxyPlacement>();
      for (const placement of job.manifest.placements) {
        if ('proxy_key' in placement.source) {
          uniqueProxies.set(placement.source.proxy_key, placement as ProxyPlacement);
        }
      }
      const missingProxies = new Map<string, ProxyPlacement>();
      const proxyMetadata: Record<
        string,
        { durationSeconds: number; width: number; height: number }
      > = {};
      let proxyCacheHits = 0;
      let proxyValidationSeconds = 0;
      for (const [key, placement] of uniqueProxies) {
        const validationStarted = performance.now();
        const cached = await this.proxyPreparer.inspectCache?.(
          placement,
          job.manifest.render_profile,
        );
        proxyValidationSeconds += (performance.now() - validationStarted) / 1000;
        if (cached) {
          proxyCacheHits += 1;
          proxyMetadata[key] = cached;
        } else missingProxies.set(key, placement);
      }
      let sourceCacheHits = 0;
      let sourceCacheMisses = 0;
      let sourceMaterializationBytes = 0;
      let assetDownloadSeconds = 0;
      let proxyEncodeSeconds = 0;
      for (const asset of job.manifest.source_assets) {
        const sourceKind =
          'media_kind' in asset && asset.media_kind === 'image' ? 'static_image' : 'gameplay';
        if (sourceKind === 'gameplay') {
          continue;
        }
        activePreparation = {
          preparationStep: 'materializing_source',
          sourceKind,
          mediaId: asset.media_id,
          expectedSizeBytes: asset.byte_size,
          startedAt: performance.now(),
        };
        const downloadStarted = performance.now();
        const source = await this.sourceResolver.resolve(
          asset.media_id,
          asset.sha256,
          asset.byte_size,
          sourceKind,
        );
        assetDownloadSeconds += (performance.now() - downloadStarted) / 1000;
        sourceMaterializationBytes += source.cacheHit ? 0 : source.byteSize;
        if (source.cacheHit) sourceCacheHits += 1;
        else sourceCacheMisses += 1;
        if ('media_kind' in asset && asset.media_kind === 'image') {
          activePreparation = {
            preparationStep: 'validating_static_image',
            sourceKind: 'static_image',
            mediaId: asset.media_id,
            expectedSizeBytes: asset.byte_size,
            startedAt: performance.now(),
          };
          await validateStaticImage(this.config.ffprobeBinary, source.path);
        }
      }
      const gameplayAssets = job.manifest.source_assets.filter(
        (asset) => !('media_kind' in asset) || asset.media_kind === 'video',
      );
      const sourceTotalBytesReference = gameplayAssets.reduce(
        (total, asset) => total + asset.byte_size,
        0,
      );
      const intervalsBySource = new Map<
        string,
        { sourceStartMicroseconds: number; sourceEndMicroseconds: number }[]
      >();
      for (const placement of uniqueProxies.values()) {
        const intervals = intervalsBySource.get(placement.source.sha256) ?? [];
        intervals.push({
          sourceStartMicroseconds: placement.source.source_start_microseconds,
          sourceEndMicroseconds: placement.source.source_end_microseconds,
        });
        intervalsBySource.set(placement.source.sha256, intervals);
      }
      const requiredSourceSeconds =
        [...intervalsBySource.values()].reduce(
          (total, intervals) => total + intervalUnionMicroseconds(intervals),
          0,
        ) / 1_000_000;
      const derivedSourceSeconds =
        [...uniqueProxies.values()].reduce(
          (total, placement) =>
            total +
            ((placement.source.derivative_source_end_microseconds ??
              placement.source.source_end_microseconds) -
              (placement.source.derivative_source_start_microseconds ??
                placement.source.source_start_microseconds)),
          0,
        ) / 1_000_000;
      const estimatedDerivativeSeconds = [...missingProxies.values()].reduce(
        (total, placement) =>
          total +
          ((placement.source.derivative_source_end_microseconds ??
            placement.source.source_end_microseconds) -
            (placement.source.derivative_source_start_microseconds ??
              placement.source.source_start_microseconds)) /
            1_000_000,
        0,
      );
      const estimatedDerivativeBytes = Math.ceil(estimatedDerivativeSeconds * 750_000);
      const estimatedRemotionBytes = Math.max(
        1_073_741_824,
        Math.ceil(job.manifest.duration_seconds * 2_000_000),
      );
      const estimatedOutputBytes = Math.max(
        268_435_456,
        Math.ceil(job.manifest.duration_seconds * 1_500_000),
      );
      const preliminaryDiskPlan = await createDiskPlan(this.config.dataRoot, {
        reusableCachedBytes: 0,
        missingFullSourceBytes: 0,
        estimatedDerivativeBytes,
        estimatedTempBytes: estimatedDerivativeBytes + estimatedOutputBytes,
        estimatedRemotionBytes,
        estimatedOutputBytes,
        reclaimableCacheBytes: 0,
        safetyReserveBytes: this.config.diskSafetyReserveBytes,
      });
      requireDiskCapacity(preliminaryDiskPlan);

      const ensuredDerivatives = new Map<string, EnsuredTemporalDerivative>();
      const fallbackProxies = new Map<string, ProxyPlacement>();
      let derivativeCacheHits = 0;
      let derivativeCacheMisses = 0;
      let derivativeGenerationSeconds = 0;
      let derivativeTransferSeconds = 0;
      let derivativeBytesGenerated = 0;
      let derivativeBytesTransferred = 0;
      let fullSourceBytesTransferred = 0;
      let fullSourceFallbackUsed = false;
      for (const [key, placement] of missingProxies) {
        const asset = gameplayAssets.find((item) => item.sha256 === placement.source.sha256);
        if (!asset) throw new ComposerError('source_asset_missing', 'Source asset is missing');
        activePreparation = {
          preparationStep: 'ensuring_temporal_derivative',
          sourceKind: 'derivative',
          mediaId: asset.media_id,
          startedAt: performance.now(),
        };
        try {
          if (!this.derivativeResolver) {
            throw new ComposerError(
              'derivative_resolver_unavailable',
              'Temporal derivative resolver is unavailable',
            );
          }
          const ensured = await this.derivativeResolver.ensure(
            asset,
            placement,
            job.manifest.render_profile,
          );
          ensuredDerivatives.set(key, ensured);
          if (ensured.cacheHit) {
            derivativeCacheHits += 1;
          } else {
            derivativeCacheMisses += 1;
            derivativeGenerationSeconds += ensured.waitSeconds;
            derivativeBytesGenerated += ensured.derivative.byte_size ?? 0;
          }
        } catch (error) {
          if (!this.config.allowFullSourceFallback) throw error;
          fallbackProxies.set(key, placement);
          fullSourceFallbackUsed = true;
        }
      }

      const fallbackSourceShas = new Set(
        [...fallbackProxies.values()].map((placement) => placement.source.sha256),
      );
      const exactDerivativeBytes = [...ensuredDerivatives.values()].reduce(
        (total, ensured) => total + (ensured.derivative.byte_size ?? 0),
        0,
      );
      let diskPlan = await createDiskPlan(this.config.dataRoot, {
        reusableCachedBytes: 0,
        missingFullSourceBytes: gameplayAssets
          .filter((asset) => fallbackSourceShas.has(asset.sha256))
          .reduce((total, asset) => total + asset.byte_size, 0),
        estimatedDerivativeBytes: exactDerivativeBytes,
        estimatedTempBytes: exactDerivativeBytes + estimatedOutputBytes,
        estimatedRemotionBytes,
        estimatedOutputBytes,
        reclaimableCacheBytes: 0,
        safetyReserveBytes: this.config.diskSafetyReserveBytes,
      });
      requireDiskCapacity(diskPlan);

      for (const [key, ensured] of ensuredDerivatives) {
        const placement = missingProxies.get(key)!;
        activePreparation = {
          preparationStep: 'transferring_temporal_derivative',
          sourceKind: 'derivative',
          mediaId: placement.source.media_id,
          expectedSizeBytes: ensured.derivative.byte_size,
          startedAt: performance.now(),
        };
        try {
          const transferStarted = performance.now();
          const materialized = await this.derivativeResolver!.materialize(ensured, placement);
          derivativeTransferSeconds += (performance.now() - transferStarted) / 1000;
          if (!materialized.cacheHit) derivativeBytesTransferred += materialized.byteSize;
          const validationStarted = performance.now();
          const proxy = await this.proxyPreparer.inspectCache(
            placement,
            job.manifest.render_profile,
          );
          proxyValidationSeconds += (performance.now() - validationStarted) / 1000;
          if (!proxy) {
            throw new ComposerError(
              'proxy_validation_failure',
              'Downloaded temporal derivative is invalid',
            );
          }
          proxyMetadata[key] = proxy;
        } catch (error) {
          if (!this.config.allowFullSourceFallback) throw error;
          fallbackProxies.set(key, placement);
          fallbackSourceShas.add(placement.source.sha256);
          fullSourceFallbackUsed = true;
        }
      }

      if (fallbackProxies.size > 0) {
        diskPlan = await createDiskPlan(this.config.dataRoot, {
          reusableCachedBytes: derivativeBytesTransferred,
          missingFullSourceBytes: gameplayAssets
            .filter((asset) => fallbackSourceShas.has(asset.sha256))
            .reduce((total, asset) => total + asset.byte_size, 0),
          estimatedDerivativeBytes: 0,
          estimatedTempBytes: estimatedDerivativeBytes + estimatedOutputBytes,
          estimatedRemotionBytes,
          estimatedOutputBytes,
          reclaimableCacheBytes: 0,
          safetyReserveBytes: this.config.diskSafetyReserveBytes,
        });
        requireDiskCapacity(diskPlan);
      }
      for (const sourceSha256 of fallbackSourceShas) {
        const placements = [...fallbackProxies.values()].filter(
          (placement) => placement.source.sha256 === sourceSha256,
        );
        const asset = job.manifest.source_assets.find((item) => item.sha256 === sourceSha256);
        if (!asset) throw new ComposerError('source_asset_missing', 'Source asset is missing');
        activePreparation = {
          preparationStep: 'materializing_source',
          sourceKind: 'gameplay',
          mediaId: asset.media_id,
          expectedSizeBytes: asset.byte_size,
          startedAt: performance.now(),
        };
        const downloadStarted = performance.now();
        const source = await this.sourceResolver.resolve(
          asset.media_id,
          asset.sha256,
          asset.byte_size,
          'gameplay',
        );
        assetDownloadSeconds += (performance.now() - downloadStarted) / 1000;
        sourceMaterializationBytes += source.cacheHit ? 0 : source.byteSize;
        if (!source.cacheHit) fullSourceBytesTransferred += source.byteSize;
        if (source.cacheHit) sourceCacheHits += 1;
        else sourceCacheMisses += 1;
        for (const placement of placements) {
          activePreparation = {
            preparationStep: 'generating_proxy',
            sourceKind: 'proxy',
            mediaId: placement.source.media_id,
            startedAt: performance.now(),
          };
          const encodeStarted = performance.now();
          const proxy = await this.proxyPreparer.prepare(
            source.path,
            placement,
            job.manifest.render_profile,
          );
          proxyEncodeSeconds += (performance.now() - encodeStarted) / 1000;
          if (proxy.cacheHit) proxyCacheHits += 1;
          proxyMetadata[placement.source.proxy_key] = proxy;
        }
      }
      const sourceBytesAvoided = Math.max(
        0,
        sourceTotalBytesReference - fullSourceBytesTransferred - derivativeBytesTransferred,
      );
      const preparationSeconds = (performance.now() - preparationStarted) / 1000;
      this.repository.updateProgress(job.id, 'rendering', 0.1);
      activePreparation = null;
      const renderStarted = performance.now();
      let lastPersisted = -1;
      let timeToFirstRenderFrameSeconds: number | null = null;
      let remotionProgress: {
        renderedDoneIn: number | null;
        encodedDoneIn: number | null;
        stitchStage: 'encoding' | 'muxing';
      } | null = null;
      await this.renderer.render(
        job.manifest,
        temporaryVideo,
        (progress) => {
          if (timeToFirstRenderFrameSeconds === null && progress.renderedFrames > 0) {
            timeToFirstRenderFrameSeconds = (performance.now() - renderStarted) / 1000;
          }
          remotionProgress = {
            renderedDoneIn: progress.renderedDoneIn,
            encodedDoneIn: progress.encodedDoneIn,
            stitchStage: progress.stitchStage,
          };
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
        },
        { renderId: job.id, proxyMetadata },
      );
      if (job.manifest.schema_version === 'render_manifest_v4') {
        if (!programAudioResult) {
          throw new ComposerError('program_mix_failed', 'Program master is unavailable');
        }
        await this.programAudio.mux(
          temporaryVideo,
          programAudioResult.path,
          temporaryOutput,
          job.manifest.audio_mix_plan,
        );
      } else {
        await this.programAudio.muxNarration(
          temporaryVideo,
          narration.path,
          temporaryOutput,
          job.manifest.duration_seconds,
        );
      }
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
          sourceCacheMisses,
          sourceMaterializationBytes,
          sourceBytesAvoided,
          sourceTotalBytesReference,
          fullSourceBytesTransferred,
          derivativeBytesGenerated,
          derivativeBytesTransferred,
          requiredSourceSeconds,
          derivedSourceSeconds,
          sourceOverfetchRatio:
            requiredSourceSeconds === 0 ? 1 : derivedSourceSeconds / requiredSourceSeconds,
          placementsCount: job.manifest.placements.filter(
            (placement) => 'proxy_key' in placement.source,
          ).length,
          plannedDerivativeCount: uniqueProxies.size,
          proxyCoalescingRatio:
            uniqueProxies.size === 0
              ? 1
              : job.manifest.placements.filter((placement) => 'proxy_key' in placement.source)
                  .length / uniqueProxies.size,
          derivativeCacheHits,
          derivativeCacheMisses,
          derivativeGenerationSeconds,
          derivativeTransferSeconds,
          proxyValidationSeconds,
          fullSourceFallbackUsed,
          assetDownloadSeconds,
          proxyEncodeSeconds,
          timeToFirstRenderFrameSeconds,
          remotionProgress,
          sourceAssetCount: job.manifest.source_assets.length,
          proxyCacheHits,
          proxyCacheMisses: uniqueProxies.size - proxyCacheHits,
          proxyCacheHitRatio: uniqueProxies.size === 0 ? 1 : proxyCacheHits / uniqueProxies.size,
          proxyCount: uniqueProxies.size,
          diskPlan,
          remotionVersion: '4.0.516',
          composerStrategyVersion: job.manifest.composer_strategy_version,
          ...(job.manifest.schema_version === 'render_manifest_v4' && programAudioResult
            ? {
                programAudio: {
                  audioMixPlanFingerprint: job.manifest.audio_mix_plan.fingerprint,
                  musicAssetId: job.manifest.audio_mix_plan.music.enabled
                    ? job.manifest.audio_mix_plan.music.asset.asset_id
                    : null,
                  musicSha256: job.manifest.audio_mix_plan.music.enabled
                    ? job.manifest.audio_mix_plan.music.asset.sha256
                    : null,
                  musicCacheHit,
                  normalizedMusicCacheHit: programAudioResult.normalizedMusicCacheHit,
                  mixCacheHit: programAudioResult.mixCacheHit,
                  masterCacheHit: programAudioResult.masterCacheHit,
                  mixSha256: programAudioResult.mixSha256,
                  masterSha256: programAudioResult.masterSha256,
                  before: programAudioResult.before,
                  after: programAudioResult.after,
                  toolIdentity: programAudioResult.toolIdentity,
                  outputChannels: 2,
                  outputSampleRate: 48000,
                  targetLufs: job.manifest.audio_mix_plan.program_master.target_lufs,
                  maxTruePeakDbtp: job.manifest.audio_mix_plan.program_master.max_true_peak_dbtp,
                  targetLra: job.manifest.audio_mix_plan.program_master.target_lra,
                  programMasterProfile: job.manifest.audio_mix_plan.program_master.profile_id,
                },
              }
            : {}),
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
      await unlink(temporaryVideo).catch(() => undefined);
      await unlink(finalOutput).catch(() => undefined);
      const failureState = this.repository.get(job.id);
      const safe = publicError(error);
      const internal = internalError(error);
      const elapsedMs = Math.round(performance.now() - totalStarted);
      const preparationContext = activePreparation
        ? {
            preparation_step: activePreparation.preparationStep,
            source_kind: activePreparation.sourceKind,
            media_id: activePreparation.mediaId,
            asset_id: activePreparation.assetId,
            expected_size_bytes: activePreparation.expectedSizeBytes,
            step_elapsed_ms: Math.round(performance.now() - activePreparation.startedAt),
          }
        : {};
      this.repository.fail(job.id, safe.category, safe.message);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'render_failed',
          render_id: job.id,
          workflow_id: job.workflowId,
          render_profile: job.renderProfile,
          phase: failureState?.phase,
          progress: failureState?.progress,
          frames_rendered: failureState?.framesRendered,
          total_frames: failureState?.totalFrames,
          elapsed_ms: elapsedMs,
          ...preparationContext,
          ...internal.diagnostics,
          internal_exception_name: internal.name,
          internal_exception_message: internal.message,
          internal_exception_stack: internal.stack,
          error_category: safe.category,
          error_message: safe.message,
        }),
      );
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
