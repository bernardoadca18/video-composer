import type { ZodType } from 'zod';

import { ComposerError } from '../core/errors.js';
import {
  type ComposerRenderInput,
  ComposerRenderInputSchema,
  type ProductionTimeline,
  ProductionTimelineSchema,
} from '../domain/contracts.js';

type Fetch = typeof fetch;

const checkedResponse = (response: Response, dependency: string): Response => {
  if (response.ok) return response;
  const status = response.status === 404 ? 404 : 502;
  throw new ComposerError(
    response.status === 404 ? 'upstream_artifact_missing' : 'dependency_unavailable',
    `${dependency} request failed`,
    status,
  );
};

export class OrchestratorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async request(path: string): Promise<Response> {
    try {
      return checkedResponse(
        await this.fetchFn(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(this.timeoutMs),
        }),
        'Orchestrator',
      );
    } catch (error) {
      if (error instanceof ComposerError) throw error;
      throw new ComposerError('dependency_unavailable', 'Orchestrator is unavailable', 502);
    }
  }

  async getTimeline(workflowId: string): Promise<ProductionTimeline> {
    const response = await this.request(`/workflow/${workflowId}/production-timeline`);
    return await this.parse(response, ProductionTimelineSchema);
  }

  async getRenderInput(workflowId: string): Promise<ComposerRenderInput> {
    const response = await this.request(`/workflow/${workflowId}/composer-render-input`);
    return await this.parse(response, ComposerRenderInputSchema);
  }

  async openNarration(workflowId: string): Promise<Response> {
    return await this.request(`/workflow/${workflowId}/audio`);
  }

  async openMusicAsset(workflowId: string, assetId: string, sha256: string): Promise<Response> {
    return await this.request(
      `/workflow/${workflowId}/music-assets/${encodeURIComponent(assetId)}` +
        `?sha256=${encodeURIComponent(sha256)}`,
    );
  }

  private async parse<T>(response: Response, schema: ZodType<T>): Promise<T> {
    try {
      return schema.parse(await response.json());
    } catch {
      throw new ComposerError('dependency_contract', 'Invalid Orchestrator response', 502);
    }
  }
}
