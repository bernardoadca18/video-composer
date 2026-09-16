import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { MediaIndexerClient } from '../src/clients/media-indexer.js';
import { OrchestratorClient } from '../src/clients/orchestrator.js';
import { loadConfig } from '../src/core/config.js';
import { requiredProxyKeysForFrameRange } from '../src/domain/frame-range.js';
import { buildRenderManifest } from '../src/domain/manifest.js';
import { resolveRenderProfile } from '../src/domain/profiles.js';
import { ClipProxyPreparer, type ProxyPlacement } from '../src/media/proxy.js';
import { TemporalDerivativeResolver } from '../src/services/temporal-derivative-resolver.js';
import { CacheCatalog } from '../src/storage/cache-catalog.js';
import { argument, windowContext, type WindowSnapshot } from './window-context.js';

const config = loadConfig();
if (config.allowFullSourceFallback)
  throw new Error('Bounded preparation forbids full-source fallback');
const context = windowContext(config);
const requests: { method: string; path: string; status: number; bytes: number }[] = [];
// Transparent production-client transport instrumentation. No mocks or source resolver.
const observedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const record = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    status: response.status,
    bytes: 0,
  };
  requests.push(record);
  if (!response.body) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        record.bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};
const client = new MediaIndexerClient(
  config.mediaIndexerBaseUrl,
  config.httpTimeoutMs,
  observedFetch,
);
let manifest = context.manifest;
let manifestFingerprint = context.row.manifest_fingerprint;
let renderFingerprint = context.row.render_fingerprint;
if (argument('--refresh-manifest') === 'true') {
  const upstream = await new OrchestratorClient(
    config.orchestratorBaseUrl,
    config.httpTimeoutMs,
  ).getRenderInput(manifest.workflow_id);
  if (upstream.production_timeline.fingerprint !== manifest.production_timeline_fingerprint) {
    throw new Error('Upstream timeline changed; cannot validate the historical render window');
  }
  const metadata = new Map();
  for (const asset of manifest.source_assets)
    metadata.set(asset.media_id, await client.getMetadata(asset.media_id));
  const built = buildRenderManifest(
    upstream.production_timeline,
    metadata,
    resolveRenderProfile(context.row.render_profile),
    context.row.mode,
    config,
    upstream.presentation,
    upstream.schema_version === 'composer_render_input_v2' ? upstream.audio_mix_plan : null,
  );
  manifest = built.manifest;
  manifestFingerprint = built.manifestFingerprint;
  renderFingerprint = built.renderFingerprint;
}
if (manifest.proxy_strategy_version !== 'proxy_strategy_v2') {
  throw new Error(
    'Historical proxy strategy: use --refresh-manifest true for a detached current-builder snapshot',
  );
}
const keys = requiredProxyKeysForFrameRange(manifest, context.range);
const placements = [...manifest.placements].filter(
  (placement): placement is ProxyPlacement =>
    'proxy_key' in placement.source &&
    placement.frame_start <= context.range[1] &&
    placement.frame_start + placement.frame_duration > context.range[0],
);
const catalog = new CacheCatalog(config.databasePath);
const proxies = new ClipProxyPreparer(config, catalog);
const derivatives = new TemporalDerivativeResolver(config, client, catalog);
const evidence: Record<string, unknown>[] = [];
const directory = path.join(config.workRoot, 'smoke');
await mkdir(directory, { recursive: true });
const prefix = path.join(
  directory,
  `${context.renderId}-frames-${context.range[0]}-${context.range[1]}`,
);
try {
  for (const key of keys) {
    const placement = placements.find((item) => item.source.proxy_key === key)!;
    const asset = manifest.source_assets.find(
      (item) => item.media_id === placement.source.media_id,
    )!;
    const cached = await proxies.inspectCache(placement, manifest.render_profile, {
      renderId: context.renderId,
    });
    const entry: Record<string, unknown> = {
      placements: placements.filter((item) => item.source.proxy_key === key).map((item) => item.id),
      media_id: asset.media_id,
      source_sha256: asset.sha256,
      source_bytes: asset.byte_size,
      proxy_key: key,
      cache_hit: cached !== null,
      derivative_range_us: [
        placement.source.derivative_source_start_microseconds,
        placement.source.derivative_source_end_microseconds,
      ],
    };
    if (!cached) {
      const ensured = await derivatives.ensure(asset, placement, manifest.render_profile);
      const materialized = await derivatives.materialize(ensured, placement);
      const inspected = await proxies.inspectCache(placement, manifest.render_profile, {
        renderId: context.renderId,
        derivativeId: ensured.derivative.id,
        required: true,
      });
      if (!inspected) throw new Error('Downloaded derivative failed proxy inspection');
      Object.assign(entry, {
        derivative: ensured.derivative,
        transfer_cache_hit: materialized.cacheHit,
        proxy: inspected,
      });
    }
    evidence.push(entry);
  }
  const snapshot: WindowSnapshot = {
    render_id: context.renderId,
    historical_render_fingerprint: context.row.render_fingerprint,
    render_fingerprint: renderFingerprint,
    manifest_fingerprint: manifestFingerprint,
    frame_range: context.range,
    manifest,
  };
  await writeFile(`${prefix}.manifest.json`, JSON.stringify(snapshot, null, 2));
} finally {
  catalog.close();
  const report = {
    render_id: context.renderId,
    frame_range: context.range,
    historical_render_fingerprint: context.row.render_fingerprint,
    render_fingerprint: renderFingerprint,
    placements: placements.map((item) => item.id),
    evidence,
    requests,
    derivative_bytes_transferred: requests
      .filter((item) => /^\/temporal-derivatives\/[^/]+\/content$/.test(item.path))
      .reduce((total, item) => total + item.bytes, 0),
    full_source_bytes_transferred: requests
      .filter((item) => /^\/media-assets\/[^/]+\/content$/.test(item.path))
      .reduce((total, item) => total + item.bytes, 0),
    full_source_fallback_used: config.allowFullSourceFallback,
    snapshot_path: `${prefix}.manifest.json`,
  };
  await writeFile(`${prefix}.preparation.json`, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
