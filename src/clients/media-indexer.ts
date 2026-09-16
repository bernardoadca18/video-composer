import { ComposerError } from '../core/errors.js';
import {
  type MediaAssetMetadata,
  MediaAssetMetadataSchema,
  type TemporalDerivative,
  TemporalDerivativeEnsureResponseSchema,
  TemporalDerivativeSchema,
} from '../domain/contracts.js';
import type { ProxyProfileSpecification } from '../domain/proxy-profile.js';

type Fetch = typeof fetch;

export class MediaIndexerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.ok) return response;
      throw new ComposerError(
        response.status === 404 ? 'source_asset_missing' : 'dependency_unavailable',
        response.status === 404 ? 'Media asset not found' : 'Media Indexer request failed',
        response.status === 404 ? 404 : 502,
      );
    } catch (error) {
      if (error instanceof ComposerError) throw error;
      throw new ComposerError('dependency_unavailable', 'Media Indexer is unavailable', 502, {
        cause: error,
      });
    }
  }

  private async requestAsset(path: string, transferSignal: AbortSignal): Promise<Response> {
    const headerController = new AbortController();
    const headerTimeout = setTimeout(
      () =>
        headerController.abort(
          new DOMException('Media Indexer response headers timed out', 'TimeoutError'),
        ),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        signal: AbortSignal.any([headerController.signal, transferSignal]),
      });
      if (response.ok) return response;
      throw new ComposerError(
        response.status === 404 ? 'source_asset_missing' : 'dependency_unavailable',
        response.status === 404 ? 'Media asset not found' : 'Media Indexer request failed',
        response.status === 404 ? 404 : 502,
      );
    } catch (error) {
      if (error instanceof ComposerError) throw error;
      throw new ComposerError('dependency_unavailable', 'Media Indexer is unavailable', 502, {
        cause: error,
      });
    } finally {
      clearTimeout(headerTimeout);
    }
  }

  async getMetadata(mediaId: string): Promise<MediaAssetMetadata> {
    const response = await this.request(`/media-assets/${mediaId}`);
    try {
      return MediaAssetMetadataSchema.parse(await response.json());
    } catch {
      throw new ComposerError('dependency_contract', 'Invalid Media Indexer metadata', 502);
    }
  }

  async openContent(mediaId: string, transferSignal: AbortSignal): Promise<Response> {
    return await this.requestAsset(`/media-assets/${mediaId}/content`, transferSignal);
  }

  async ensureTemporalDerivative(input: {
    mediaId: string;
    sourceSha256: string;
    sourceStartMicroseconds: number;
    sourceEndMicroseconds: number;
    profileIdentity: string;
    profile: ProxyProfileSpecification;
    waitTimeoutMs: number;
    pollIntervalMs: number;
  }): Promise<{ derivative: TemporalDerivative; created: boolean; reusedCompleted: boolean }> {
    const response = await this.request(`/media-assets/${input.mediaId}/temporal-derivatives`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract_version: 'temporal_derivative_request_v1',
        source_sha256: input.sourceSha256,
        source_start_microseconds: input.sourceStartMicroseconds,
        source_end_microseconds: input.sourceEndMicroseconds,
        profile_identity: input.profileIdentity,
        profile: input.profile,
      }),
    });
    let ensured;
    try {
      ensured = TemporalDerivativeEnsureResponseSchema.parse(await response.json());
    } catch {
      throw new ComposerError('dependency_contract', 'Invalid temporal derivative response', 502);
    }
    const deadline = performance.now() + input.waitTimeoutMs;
    const reusedCompleted = !ensured.created && ensured.derivative.status === 'completed';
    let derivative = ensured.derivative;
    while (derivative.status === 'pending' || derivative.status === 'processing') {
      if (performance.now() >= deadline) {
        throw new ComposerError(
          'derivative_generation_timeout',
          'Temporal derivative generation timed out',
          504,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs));
      const status = await this.request(`/temporal-derivatives/${derivative.id}`);
      try {
        derivative = TemporalDerivativeSchema.parse(await status.json());
      } catch {
        throw new ComposerError('dependency_contract', 'Invalid temporal derivative status', 502);
      }
    }
    if (
      derivative.status !== 'completed' ||
      derivative.sha256 === null ||
      derivative.byte_size === null ||
      derivative.content_url === null
    ) {
      throw new ComposerError(
        'derivative_generation_failure',
        derivative.error ?? 'Temporal derivative generation failed',
        502,
      );
    }
    return { derivative, created: ensured.created, reusedCompleted };
  }

  async openTemporalDerivative(
    derivativeId: string,
    transferSignal: AbortSignal,
  ): Promise<Response> {
    return await this.requestAsset(`/temporal-derivatives/${derivativeId}/content`, transferSignal);
  }
}
