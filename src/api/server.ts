import path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppConfig } from '../core/config.js';
import { ComposerError, publicError } from '../core/errors.js';
import { RenderRequestSchema } from '../domain/contracts.js';
import { renderProfiles } from '../domain/profiles.js';
import type { RenderJob } from '../jobs/repository.js';
import type { RenderCoordinator } from '../services/render-coordinator.js';
import { sendControlledFile } from './files.js';

const IdParams = z.object({ id: z.string().uuid() });
const AssetParams = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) });
const ImageAssetQuery = z.object({
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

export interface ServerContext {
  config: AppConfig;
  coordinator: RenderCoordinator;
  queueDepth: () => number;
  isReady: () => boolean;
}

const jobResponse = (job: RenderJob): Record<string, unknown> => ({
  id: job.id,
  workflow_id: job.workflowId,
  production_timeline_id: job.productionTimelineId,
  production_timeline_fingerprint: job.productionTimelineFingerprint,
  render_profile: job.renderProfile,
  render_profile_identity: job.renderProfileIdentity,
  mode: job.mode,
  status: job.status,
  phase: job.phase,
  progress: job.progress,
  frames_rendered: job.framesRendered,
  total_frames: job.totalFrames,
  render_fingerprint: job.renderFingerprint,
  manifest_fingerprint: job.manifestFingerprint,
  presentation_fingerprint:
    job.manifest.schema_version === 'render_manifest_v3'
      ? job.manifest.presentation.fingerprint
      : null,
  created_at: job.createdAt,
  started_at: job.startedAt,
  completed_at: job.completedAt,
  output: job.status === 'completed' ? job.output : null,
  metrics: job.metrics,
  error:
    job.status === 'failed' ? { category: job.errorCategory, message: job.errorMessage } : null,
  status_url: `/v1/renders/${job.id}`,
  video_url: job.status === 'completed' ? `/v1/renders/${job.id}/video` : null,
});

export const buildServer = (context: ServerContext): FastifyInstance => {
  const server = Fastify({
    logger: { level: context.config.logLevel },
    bodyLimit: 1024 * 1024,
  });

  server.get('/health/live', () => ({ status: 'ok' }));
  server.get('/health/ready', async (_request, reply) => {
    if (!context.isReady()) return await reply.code(503).send({ status: 'not_ready' });
    return { status: 'ready', worker: 'operational', queue_depth: context.queueDepth() };
  });

  server.get('/v1/render-profiles', () => ({
    items: [...renderProfiles.values()].map((profile) => ({
      name: profile.name,
      version: profile.version,
      identity: profile.identity,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      container: profile.container,
      video_codec: profile.videoCodec,
      audio_codec: profile.audioCodec,
      audio_sample_rate: profile.audioSampleRate,
      fit_mode: profile.fitMode,
      final_gap_policy: profile.finalGapPolicy,
      preview_gap_policy: profile.previewGapPolicy,
    })),
  }));

  server.post('/v1/renders', async (request, reply) => {
    const payload = RenderRequestSchema.parse(request.body);
    const rawKey = request.headers['idempotency-key'];
    if (Array.isArray(rawKey)) {
      throw new ComposerError('invalid_idempotency_key', 'One Idempotency-Key is required', 422);
    }
    const result = await context.coordinator.ensure(payload, rawKey ?? null);
    return await reply.code(202).send({ created: result.created, ...jobResponse(result.job) });
  });

  server.get('/v1/renders/:id', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const job = context.coordinator.get(id);
    if (!job) return await reply.code(404).send({ error: 'render_not_found' });
    return jobResponse(job);
  });

  server.get('/v1/renders/:id/video', async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const job = context.coordinator.get(id);
    if (!job) return await reply.code(404).send({ error: 'render_not_found' });
    if (job.status !== 'completed') {
      return await reply.code(409).send({ error: 'render_not_completed' });
    }
    return await sendControlledFile(
      request,
      reply,
      path.join(context.config.outputRoot, `${id}.mp4`),
      'video/mp4',
      `${id}.mp4`,
    );
  });

  server.get('/internal-assets/narration/:key', async (request, reply) => {
    const { key } = AssetParams.parse(request.params);
    return await sendControlledFile(
      request,
      reply,
      path.join(context.config.narrationCacheRoot, `${key}.wav`),
      'audio/wav',
    );
  });

  server.get('/internal-assets/proxy/:key', async (request, reply) => {
    const { key } = AssetParams.parse(request.params);
    return await sendControlledFile(
      request,
      reply,
      path.join(context.config.proxyCacheRoot, `${key}.mp4`),
      'video/mp4',
    );
  });

  server.get('/internal-assets/image/:key', async (request, reply) => {
    const { key } = AssetParams.parse(request.params);
    const { content_type: contentType } = ImageAssetQuery.parse(request.query);
    return await sendControlledFile(
      request,
      reply,
      path.join(context.config.sourceCacheRoot, `${key}.media`),
      contentType,
    );
  });

  server.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return await reply
        .code(422)
        .send({ error: 'invalid_request', message: 'Request is invalid' });
    }
    const safe = publicError(error);
    server.log.error({ err: error, category: safe.category }, 'request failed');
    return await reply.code(safe.status).send({ error: safe.category, message: safe.message });
  });
  return server;
};
