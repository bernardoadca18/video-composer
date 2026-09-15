import { ComposerError } from '../core/errors.js';
import { type MediaAssetMetadata, MediaAssetMetadataSchema } from '../domain/contracts.js';

type Fetch = typeof fetch;

export class MediaIndexerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async request(path: string): Promise<Response> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
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
}
