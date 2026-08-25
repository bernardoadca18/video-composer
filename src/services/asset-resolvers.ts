import path from 'node:path';

import type { MediaIndexerClient } from '../clients/media-indexer.js';
import type { OrchestratorClient } from '../clients/orchestrator.js';
import type { CachedFile } from '../storage/atomic-cache.js';
import { materializeResponse } from '../storage/atomic-cache.js';

export class NarrationAssetResolver {
  constructor(
    private readonly root: string,
    private readonly client: OrchestratorClient,
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
      async () => await this.client.openNarration(workflowId),
    );
  }
}

export class GameplaySourceResolver {
  constructor(
    private readonly root: string,
    private readonly client: MediaIndexerClient,
  ) {}

  async resolve(
    mediaId: string,
    expectedSha256: string,
    expectedSize: number,
  ): Promise<CachedFile> {
    return await materializeResponse(
      path.join(this.root, `${expectedSha256}.media`),
      expectedSha256,
      expectedSize,
      async () => await this.client.openContent(mediaId),
    );
  }
}
