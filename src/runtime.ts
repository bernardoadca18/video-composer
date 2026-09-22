import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { MediaIndexerClient } from './clients/media-indexer.js';
import { OrchestratorClient } from './clients/orchestrator.js';
import { buildServer } from './api/server.js';
import type { AppConfig } from './core/config.js';
import { RenderJobProcessor } from './jobs/processor.js';
import { RenderJobRepository } from './jobs/repository.js';
import { RenderWorker } from './jobs/worker.js';
import { ClipProxyPreparer } from './media/proxy.js';
import { ProgramAudioProcessor } from './media/program-audio.js';
import { runProcess } from './media/process.js';
import { RemotionVideoRenderer } from './remotion/renderer.js';
import {
  GameplaySourceResolver,
  MusicAssetResolver,
  NarrationAssetResolver,
} from './services/asset-resolvers.js';
import { RenderCoordinator } from './services/render-coordinator.js';
import { TemporalDerivativeResolver } from './services/temporal-derivative-resolver.js';
import { CacheCatalog } from './storage/cache-catalog.js';

export const startRuntime = async (config: AppConfig): Promise<void> => {
  // Create all required directories
  await Promise.all(
    [
      config.sourceCacheRoot,
      config.proxyCacheRoot,
      config.narrationCacheRoot,
      config.musicCacheRoot,
      config.programAudioCacheRoot,
      config.workRoot,
      config.outputRoot,
      config.recoveryRoot,
    ].map(async (directory) => await mkdir(directory, { recursive: true })),
  );

  // Validate critical directories are writable
  const criticalDirs = [
    { name: 'database', path: path.dirname(config.databasePath) },
    { name: 'work', path: config.workRoot },
    { name: 'outputs', path: config.outputRoot },
    { name: 'recovery', path: config.recoveryRoot },
  ];

  for (const dir of criticalDirs) {
    const testFile = path.join(dir.path, `.write_test_${process.pid}`);
    try {
      await writeFile(testFile, 'WRITE_TEST');
      await unlink(testFile);
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'storage_directory_validated',
          directory: dir.name,
          path: dir.path,
        }),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'storage_directory_not_writable',
          directory: dir.name,
          path: dir.path,
          error_message: errorMessage,
        }),
      );
      throw new Error(
        `Critical storage directory '${dir.name}' at '${dir.path}' is not writable: ${errorMessage}`,
      );
    }
  }
  await Promise.all([
    runProcess(config.ffmpegBinary, ['-version'], 'ffmpeg_unavailable'),
    runProcess(config.ffprobeBinary, ['-version'], 'ffprobe_unavailable'),
  ]);
  const repository = new RenderJobRepository(config.databasePath);
  const cacheCatalog = new CacheCatalog(config.databasePath);
  const orchestrator = new OrchestratorClient(config.orchestratorBaseUrl, config.httpTimeoutMs);
  const mediaIndexer = new MediaIndexerClient(config.mediaIndexerBaseUrl, config.httpTimeoutMs);
  const renderer = new RemotionVideoRenderer(config);
  await renderer.initialize();
  const processor = new RenderJobProcessor(
    config,
    repository,
    new NarrationAssetResolver(
      config.narrationCacheRoot,
      orchestrator,
      config.assetDownloadIdleTimeoutMs,
      cacheCatalog,
    ),
    new GameplaySourceResolver(
      config.sourceCacheRoot,
      mediaIndexer,
      config.assetDownloadIdleTimeoutMs,
      cacheCatalog,
    ),
    new MusicAssetResolver(
      config.musicCacheRoot,
      orchestrator,
      config.assetDownloadIdleTimeoutMs,
      cacheCatalog,
    ),
    new ClipProxyPreparer(config, cacheCatalog),
    renderer,
    new ProgramAudioProcessor(config),
    new TemporalDerivativeResolver(config, mediaIndexer, cacheCatalog),
  );
  const worker = new RenderWorker(processor, config.maxQueueSize, config.renderWorkerConcurrency);
  const coordinator = new RenderCoordinator(config, repository, worker, orchestrator, mediaIndexer);
  let ready = false;
  const server = buildServer({
    config,
    coordinator,
    queueDepth: () => worker.queueDepth,
    isReady: () => ready,
  });
  await server.listen({ host: config.host, port: config.port });
  worker.start();
  const recovered = await coordinator.recover();
  ready = true;
  server.log.info(
    {
      composer_strategy_version: 'video_composer_v1',
      remotion_version: '4.0.516',
      render_worker_concurrency: config.renderWorkerConcurrency,
      http_timeout_ms: config.httpTimeoutMs,
      asset_download_idle_timeout_ms: config.assetDownloadIdleTimeoutMs,
      recovered_jobs: recovered,
    },
    'video composer ready',
  );
  const shutdown = async (): Promise<void> => {
    ready = false;
    await server.close();
    await worker.stop();
    repository.close();
    cacheCatalog.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
};
