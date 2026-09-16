import path from 'node:path';

import type { MediaIndexerClient } from '../clients/media-indexer.js';
import type { AppConfig } from '../core/config.js';
import { ComposerError } from '../core/errors.js';
import type { TemporalDerivative } from '../domain/contracts.js';
import { proxyProfileForRender, proxyProfileSpecification } from '../domain/proxy-profile.js';
import type { ProxyPlacement } from '../media/proxy.js';
import { materializeResponse, type CachedFile } from '../storage/atomic-cache.js';
import type { CacheCatalog } from '../storage/cache-catalog.js';

export interface EnsuredTemporalDerivative {
  derivative: TemporalDerivative;
  created: boolean;
  cacheHit: boolean;
  waitSeconds: number;
}

export interface DerivativeSourceAsset {
  media_id: string;
  sha256: string;
  byte_size: number;
}

export class TemporalDerivativeResolver {
  constructor(
    private readonly config: AppConfig,
    private readonly client: MediaIndexerClient,
    private readonly catalog?: CacheCatalog,
  ) {}

  async ensure(
    asset: DerivativeSourceAsset,
    placement: ProxyPlacement,
    renderProfile: { width: number; height: number; fps: number },
  ): Promise<EnsuredTemporalDerivative> {
    const profile = proxyProfileForRender(renderProfile);
    const sourceStart =
      placement.source.derivative_source_start_microseconds ??
      placement.source.source_start_microseconds;
    const sourceEnd =
      placement.source.derivative_source_end_microseconds ??
      placement.source.source_end_microseconds;
    const started = performance.now();
    const result = await this.client.ensureTemporalDerivative({
      mediaId: asset.media_id,
      sourceSha256: asset.sha256,
      sourceStartMicroseconds: sourceStart,
      sourceEndMicroseconds: sourceEnd,
      profileIdentity: profile.identity,
      profile: proxyProfileSpecification(profile),
      waitTimeoutMs: this.config.derivativeWaitTimeoutMs,
      pollIntervalMs: this.config.derivativePollIntervalMs,
    });
    const derivative = result.derivative;
    if (
      derivative.identity !== placement.source.proxy_key ||
      derivative.source_media_id !== asset.media_id ||
      derivative.source_sha256 !== asset.sha256 ||
      derivative.source_start_microseconds !== sourceStart ||
      derivative.source_end_microseconds !== sourceEnd ||
      derivative.profile_identity !== profile.identity
    ) {
      throw new ComposerError(
        'dependency_contract',
        'Temporal derivative identity does not match proxy plan',
        502,
      );
    }
    return {
      derivative,
      created: result.created,
      cacheHit: result.reusedCompleted,
      waitSeconds: (performance.now() - started) / 1000,
    };
  }

  async materialize(
    ensured: EnsuredTemporalDerivative,
    placement: ProxyPlacement,
  ): Promise<CachedFile> {
    const derivative = ensured.derivative;
    if (derivative.sha256 === null || derivative.byte_size === null) {
      throw new ComposerError(
        'dependency_contract',
        'Completed derivative lacks integrity data',
        502,
      );
    }
    const target = path.join(this.config.proxyCacheRoot, `${placement.source.proxy_key}.mp4`);
    return await materializeResponse(
      target,
      derivative.sha256,
      derivative.byte_size,
      async (signal) => await this.client.openTemporalDerivative(derivative.id, signal),
      {
        idleTimeoutMs: this.config.assetDownloadIdleTimeoutMs,
        maximumBytes: derivative.byte_size,
        context: {
          sourceKind: 'gameplay',
          mediaId: placement.source.media_id,
        },
        cacheKind: 'proxy',
        profileIdentity: derivative.profile_identity,
        ...(this.catalog ? { catalog: this.catalog } : {}),
      },
    );
  }
}
