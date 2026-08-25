import { mkdir } from 'node:fs/promises';

import { MediaIndexerClient } from './clients/media-indexer.js';
import { OrchestratorClient } from './clients/orchestrator.js';
import { buildServer } from './api/server.js';
import type { AppConfig } from './core/config.js';
import { RenderJobProcessor } from './jobs/processor.js';
import { RenderJobRepository } from './jobs/repository.js';
import { RenderWorker } from './jobs/worker.js';
import { ClipProxyPreparer } from './media/proxy.js';
import { runProcess } from './media/process.js';
import { RemotionVideoRenderer } from './remotion/renderer.js';
import { GameplaySourceResolver, NarrationAssetResolver } from './services/asset-resolvers.js';
import { RenderCoordinator } from './services/render-coordinator.js';

export const startRuntime = async (config: AppConfig): Promise<void> => {
  await Promise.all(
    [
      config.sourceCacheRoot,
      config.proxyCacheRoot,
      config.narrationCacheRoot,
      config.workRoot,
      config.outputRoot,
    ].map(async (directory) => await mkdir(directory, { recursive: true })),
  );
  await Promise.all([
    runProcess(config.ffmpegBinary, ['-version'], 'ffmpeg_unavailable'),
    runProcess(config.ffprobeBinary, ['-version'], 'ffprobe_unavailable'),
  ]);
  const repository = new RenderJobRepository(config.databasePath);
  const orchestrator = new OrchestratorClient(config.orchestratorBaseUrl, config.httpTimeoutMs);
  const mediaIndexer = new MediaIndexerClient(config.mediaIndexerBaseUrl, config.httpTimeoutMs);
  const renderer = new RemotionVideoRenderer(config);
  await renderer.initialize();
  const processor = new RenderJobProcessor(
    config,
    repository,
    new NarrationAssetResolver(config.narrationCacheRoot, orchestrator),
    new GameplaySourceResolver(config.sourceCacheRoot, mediaIndexer),
    new ClipProxyPreparer(config),
    renderer,
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
      recovered_jobs: recovered,
    },
    'video composer ready',
  );
  const shutdown = async (): Promise<void> => {
    ready = false;
    await server.close();
    await worker.stop();
    repository.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
};
