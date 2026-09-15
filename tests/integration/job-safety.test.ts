import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MediaIndexerClient } from '../../src/clients/media-indexer.js';
import { OrchestratorClient } from '../../src/clients/orchestrator.js';
import { RenderJobProcessor } from '../../src/jobs/processor.js';
import { RenderJobRepository } from '../../src/jobs/repository.js';
import type { RenderWorker } from '../../src/jobs/worker.js';
import { runProcess } from '../../src/media/process.js';
import type { ProgramAudioProcessor } from '../../src/media/program-audio.js';
import type { ClipProxyPreparer } from '../../src/media/proxy.js';
import type { VideoRenderer } from '../../src/remotion/renderer.js';
import type {
  GameplaySourceResolver,
  MusicAssetResolver,
  NarrationAssetResolver,
} from '../../src/services/asset-resolvers.js';
import { RenderCoordinator } from '../../src/services/render-coordinator.js';
import { renderManifest, testConfig, TIMELINE_ID, WORKFLOW_ID } from '../helpers.js';

const repositories: RenderJobRepository[] = [];
afterEach(() => {
  repositories.splice(0).forEach((item) => item.close());
  vi.restoreAllMocks();
});

const createJob = (repository: RenderJobRepository, root: string, id: string) =>
  repository.create({
    id,
    workflowId: WORKFLOW_ID,
    productionTimelineId: TIMELINE_ID,
    productionTimelineFingerprint: '2'.repeat(64),
    renderProfile: 'youtube_1080p30_v1',
    renderProfileIdentity: '3'.repeat(64),
    mode: 'final',
    idempotencyKey: null,
    requestFingerprint: '4'.repeat(64),
    renderFingerprint: id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
    manifestFingerprint: '5'.repeat(64),
    manifest: renderManifest(root),
  });

describe('render job safety', () => {
  it('logs private diagnostics for an unknown preparation error and keeps public state safe', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-observability-'));
    const config = testConfig(root);
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const job = createJob(repository, root, '80000000-0000-4000-8000-000000000002');
    const lowLevel = new Error('synthetic stream socket reset');
    lowLevel.name = 'UndiciStreamError';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = new RenderJobProcessor(
      config,
      repository,
      { resolve: async () => await Promise.reject(lowLevel) } as unknown as NarrationAssetResolver,
      {} as GameplaySourceResolver,
      {} as MusicAssetResolver,
      {} as ClipProxyPreparer,
      {} as VideoRenderer,
      {} as ProgramAudioProcessor,
    );

    await processor.process(job.id);

    const failed = repository.get(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.progress).toBe(0.02);
    expect(failed.framesRendered).toBe(0);
    expect(failed.errorCategory).toBe('internal_error');
    expect(failed.errorMessage).toBe('Video Composer operation failed');
    const record = JSON.parse(String(errorLog.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({
      event: 'render_failed',
      render_id: job.id,
      workflow_id: WORKFLOW_ID,
      render_profile: 'youtube_1080p30_v1',
      phase: 'preparing_assets',
      progress: 0.02,
      frames_rendered: 0,
      preparation_step: 'materializing_narration',
      source_kind: 'narration',
      internal_exception_name: 'UndiciStreamError',
      internal_exception_message: 'synthetic stream socket reset',
      error_category: 'internal_error',
      error_message: 'Video Composer operation failed',
    });
    expect(record.internal_exception_stack).toContain('synthetic stream socket reset');
    expect(record.elapsed_ms).toEqual(expect.any(Number));
  });

  it('does not publish an invalid partial output', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-job-'));
    const config = testConfig(root);
    const narrationPath = path.join(root, 'narration.wav');
    const sourcePath = path.join(root, 'source.mp4');
    await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=6',
        '-c:a',
        'pcm_s16le',
        '-y',
        narrationPath,
      ],
      'fixture',
    );
    await writeFile(sourcePath, 'controlled source placeholder');
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const job = createJob(repository, root, '80000000-0000-4000-8000-000000000003');
    const processor = new RenderJobProcessor(
      config,
      repository,
      {
        resolve: async () => ({
          path: narrationPath,
          cacheHit: false,
          byteSize: 1,
          sha256: job.manifest.narration.sha256,
        }),
      } as unknown as NarrationAssetResolver,
      {
        resolve: async () => ({ path: sourcePath, cacheHit: false, byteSize: 1, sha256: 'x' }),
      } as unknown as GameplaySourceResolver,
      {} as MusicAssetResolver,
      {
        prepare: async (_source: string, placement: (typeof job.manifest.placements)[number]) => ({
          path: sourcePath,
          key:
            'proxy_key' in placement.source ? placement.source.proxy_key : placement.source.sha256,
          cacheHit: false,
          durationSeconds: 3,
          width: 640,
          height: 360,
        }),
      } as unknown as ClipProxyPreparer,
      {
        initialize: async () => undefined,
        render: async (_manifest: unknown, outputPath: string) =>
          await writeFile(outputPath, 'bad'),
      } as unknown as VideoRenderer,
      {
        muxNarration: async (_videoPath: string, _narrationPath: string, outputPath: string) =>
          await writeFile(outputPath, 'bad'),
      } as unknown as ProgramAudioProcessor,
    );

    await processor.process(job.id);

    expect(repository.get(job.id)?.status).toBe('failed');
    expect(repository.get(job.id)?.errorCategory).toBe('ffprobe_failure');
    await expect(stat(path.join(config.outputRoot, `${job.id}.mp4`))).rejects.toThrow();
  });

  it('requeues interrupted work and removes an invalid final artifact', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'composer-recovery-'));
    const config = testConfig(root);
    const repository = new RenderJobRepository(config.databasePath);
    repositories.push(repository);
    const job = createJob(repository, root, '80000000-0000-4000-8000-000000000004');
    repository.updateProgress(job.id, 'rendering', 0.4, 20);
    const invalidFinal = path.join(config.outputRoot, `${job.id}.mp4`);
    await writeFile(invalidFinal, 'partial').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(config.outputRoot, { recursive: true });
      await writeFile(invalidFinal, 'partial');
    });
    const enqueued: string[] = [];
    const coordinator = new RenderCoordinator(
      config,
      repository,
      {
        enqueue: (id: string) => {
          enqueued.push(id);
          return true;
        },
      } as unknown as RenderWorker,
      new OrchestratorClient('http://unused', 100),
      new MediaIndexerClient('http://unused', 100),
    );

    expect(await coordinator.recover()).toBe(1);
    expect(repository.get(job.id)?.status).toBe('queued');
    expect(enqueued).toEqual([job.id]);
    await expect(stat(invalidFinal)).rejects.toThrow();
  });
});
