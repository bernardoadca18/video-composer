import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { MediaIndexerClient } from '../clients/media-indexer.js';
import type { OrchestratorClient } from '../clients/orchestrator.js';
import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import { fingerprint } from '../core/identity.js';
import type { MediaAssetMetadata, RenderRequest } from '../domain/contracts.js';
import { buildRenderManifest, ManifestValidationError } from '../domain/manifest.js';
import { resolveRenderProfile, UnknownRenderProfileError } from '../domain/profiles.js';
import { validateOutput } from '../media/output-validator.js';
import type { RenderJob, RenderJobRepository } from '../jobs/repository.js';
import type { RenderWorker } from '../jobs/worker.js';

export interface EnsureRenderResult {
  job: RenderJob;
  created: boolean;
}

export class RenderCoordinator {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: RenderJobRepository,
    private readonly worker: RenderWorker,
    private readonly orchestrator: OrchestratorClient,
    private readonly mediaIndexer: MediaIndexerClient,
  ) {}

  get(id: string): RenderJob | null {
    return this.repository.get(id);
  }

  private async completedArtifactIsValid(job: RenderJob): Promise<boolean> {
    if (job.status !== 'completed' || !job.outputPath) return false;
    try {
      const output = await validateOutput(this.config, job.outputPath, job.manifest);
      return output.sha256 === job.output?.sha256;
    } catch {
      return false;
    }
  }

  async ensure(request: RenderRequest, idempotencyKey: string | null): Promise<EnsureRenderResult> {
    if (idempotencyKey && idempotencyKey.length > 200) {
      throw new ComposerError('invalid_idempotency_key', 'Idempotency-Key is too long', 422);
    }
    let profile;
    try {
      profile = resolveRenderProfile(request.render_profile);
    } catch (error) {
      if (error instanceof UnknownRenderProfileError) {
        throw new ComposerError('unknown_render_profile', 'Unknown render profile', 422);
      }
      throw error;
    }
    const renderInput = await this.orchestrator.getRenderInput(request.workflow_id);
    const timeline = renderInput.production_timeline;
    const presentation = renderInput.presentation;
    const mediaIds = [
      ...new Set(timeline.tracks.primary_visual.placements.map((item) => item.source.media_id)),
    ];
    if (mediaIds.length > this.config.maxSourceAssets) {
      throw new ComposerError('render_limit', 'Timeline exceeds source asset limit', 422);
    }
    const metadataItems = await Promise.all(
      mediaIds.map(async (id) => await this.mediaIndexer.getMetadata(id)),
    );
    const metadata = new Map<string, MediaAssetMetadata>(
      metadataItems.map((item) => [item.id, item]),
    );
    let built;
    try {
      built = buildRenderManifest(
        timeline,
        metadata,
        profile,
        request.mode,
        this.config,
        presentation,
      );
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        throw new ComposerError(error.category, error.message, 422);
      }
      throw error;
    }
    const requestIdentity: Record<string, unknown> = {
      workflow_id: request.workflow_id,
      render_profile: profile.name,
      render_profile_identity: profile.identity,
      mode: request.mode,
      production_timeline_id: timeline.id,
      production_timeline_fingerprint: timeline.fingerprint,
    };
    if (presentation) {
      requestIdentity.presentation_fingerprint = presentation.fingerprint;
      requestIdentity.contract = 'composer_render_request_v2_presentation';
    }
    const requestFingerprint = fingerprint(requestIdentity);
    if (idempotencyKey) {
      const existing = this.repository.byIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new ComposerError(
            'idempotency_conflict',
            'Idempotency-Key was reused with different render semantics',
            409,
          );
        }
        if (existing.status === 'completed' && !(await this.completedArtifactIsValid(existing))) {
          if (!this.worker.hasCapacity) {
            throw new ComposerError('queue_full', 'Render queue is full', 429);
          }
          if (existing.outputPath) await unlink(existing.outputPath).catch(() => undefined);
          this.repository.requeue(existing.id);
          this.worker.enqueue(existing.id);
          return { job: this.repository.get(existing.id)!, created: false };
        }
        return { job: existing, created: false };
      }
    }
    const equivalent = this.repository.byRenderFingerprint(built.renderFingerprint);
    if (equivalent) {
      if (equivalent.status === 'completed' && (await this.completedArtifactIsValid(equivalent))) {
        return { job: equivalent, created: false };
      }
      if (equivalent.status === 'failed' || equivalent.status === 'completed') {
        if (!this.worker.hasCapacity) {
          throw new ComposerError('queue_full', 'Render queue is full', 429);
        }
        if (equivalent.outputPath) await unlink(equivalent.outputPath).catch(() => undefined);
        this.repository.requeue(equivalent.id);
        this.worker.enqueue(equivalent.id);
      }
      return { job: this.repository.get(equivalent.id)!, created: false };
    }
    if (!this.worker.hasCapacity)
      throw new ComposerError('queue_full', 'Render queue is full', 429);
    const job = this.repository.create({
      id: randomUUID(),
      workflowId: request.workflow_id,
      productionTimelineId: timeline.id,
      productionTimelineFingerprint: timeline.fingerprint,
      renderProfile: profile.name,
      renderProfileIdentity: profile.identity,
      mode: request.mode,
      idempotencyKey,
      requestFingerprint,
      renderFingerprint: built.renderFingerprint,
      manifestFingerprint: built.manifestFingerprint,
      manifest: built.manifest,
    });
    if (!this.worker.enqueue(job.id)) {
      this.repository.fail(job.id, 'queue_full', 'Render queue is full');
      throw new ComposerError('queue_full', 'Render queue is full', 429);
    }
    return { job, created: true };
  }

  async recover(): Promise<number> {
    await mkdir(this.config.outputRoot, { recursive: true });
    let recovered = 0;
    for (const job of this.repository.recoverable()) {
      const expectedOutput = path.join(this.config.outputRoot, `${job.id}.mp4`);
      try {
        const output = await validateOutput(this.config, expectedOutput, job.manifest);
        this.repository.complete(
          job.id,
          expectedOutput,
          { ...output },
          {
            recoveredAfterRestart: true,
            composerStrategyVersion: job.manifest.composer_strategy_version,
            remotionVersion: '4.0.516',
          },
        );
      } catch {
        await unlink(expectedOutput).catch(() => undefined);
        this.repository.requeue(job.id);
        this.worker.enqueue(job.id, true);
      }
      recovered += 1;
    }
    return recovered;
  }
}
