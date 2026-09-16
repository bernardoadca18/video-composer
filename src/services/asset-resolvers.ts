import path from 'node:path';

import type { MediaIndexerClient } from '../clients/media-indexer.js';
import type { OrchestratorClient } from '../clients/orchestrator.js';
import { ComposerError } from '../core/errors.js';
import type { CachedFile } from '../storage/atomic-cache.js';
import { materializeResponse } from '../storage/atomic-cache.js';
import type { CacheCatalog } from '../storage/cache-catalog.js';

export class NarrationAssetResolver {
  constructor(
    private readonly root: string,
    private readonly client: OrchestratorClient,
    private readonly idleTimeoutMs = 30_000,
    private readonly catalog?: CacheCatalog,
  ) {}

  async resolve(
    workflowId: string,
    expectedSha256: string,
    expectedSize: number | null,
  ): Promise<CachedFile> {
    return await materializeResponse(
      path.join(this.root, `${expectedSha256}.wav`),
      expectedSha256,
      expectedSize,
      async (signal) => await this.client.openNarration(workflowId, signal),
      {
        idleTimeoutMs: this.idleTimeoutMs,
        maximumBytes: expectedSize ?? 2_147_483_648,
        context: { sourceKind: 'narration' },
        cacheKind: 'narration',
        ...(this.catalog ? { catalog: this.catalog } : {}),
      },
    );
  }
}

export class GameplaySourceResolver {
  constructor(
    private readonly root: string,
    private readonly client: MediaIndexerClient,
    private readonly idleTimeoutMs = 30_000,
    private readonly catalog?: CacheCatalog,
  ) {}

  async resolve(
    mediaId: string,
    expectedSha256: string,
    expectedSize: number,
    sourceKind: 'gameplay' | 'static_image' = 'gameplay',
  ): Promise<CachedFile> {
    return await materializeResponse(
      path.join(this.root, `${expectedSha256}.media`),
      expectedSha256,
      expectedSize,
      async (signal) => await this.client.openContent(mediaId, signal),
      {
        idleTimeoutMs: this.idleTimeoutMs,
        maximumBytes: expectedSize,
        context: { sourceKind, mediaId },
        cacheKind: 'source',
        ...(this.catalog ? { catalog: this.catalog } : {}),
      },
    );
  }
}

export class MusicAssetResolver {
  constructor(
    private readonly root: string,
    private readonly client: OrchestratorClient,
    private readonly idleTimeoutMs = 30_000,
    private readonly catalog?: CacheCatalog,
  ) {}

  async resolve(
    workflowId: string,
    assetId: string,
    expectedSha256: string,
    expectedSize: number,
    format: 'wav' | 'flac',
  ): Promise<CachedFile> {
    try {
      return await materializeResponse(
        path.join(this.root, `${expectedSha256}.${format}`),
        expectedSha256,
        expectedSize,
        async (signal) =>
          await this.client.openMusicAsset(workflowId, assetId, expectedSha256, signal),
        {
          idleTimeoutMs: this.idleTimeoutMs,
          maximumBytes: expectedSize,
          context: { sourceKind: 'music', assetId },
          cacheKind: 'music',
          ...(this.catalog ? { catalog: this.catalog } : {}),
        },
      );
    } catch (error) {
      if (
        error instanceof ComposerError &&
        ['upstream_artifact_missing', 'dependency_unavailable'].includes(error.category)
      ) {
        throw new ComposerError('music_asset_unavailable', 'Music asset is unavailable', 409, {
          cause: error,
          diagnostics: error.diagnostics,
        });
      }
      if (error instanceof ComposerError && error.category === 'asset_materialization_failed')
        throw error;
      throw new ComposerError(
        'music_asset_integrity_failed',
        'Music asset failed immutable identity validation',
        409,
        {
          cause: error,
          diagnostics: error instanceof ComposerError ? error.diagnostics : {},
        },
      );
    }
  }
}
