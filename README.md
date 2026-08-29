# NeoVids Video Composer

Stage 16 deterministic rendering service. It converts the frozen Orchestrator
`ProductionTimeline` into a validated MP4 without making editorial decisions.

```text
ProductionTimeline
  -> validated RenderManifest
  -> narration/source materialization over trusted HTTP
  -> exact silent clip proxies
  -> static Remotion composition
  -> independently validated atomic MP4
```

The Composer never calls Media Search, Qwen, Whisper, Narration Alignment or Visual Director. It
does not modify upstream artifacts and accepts neither local paths nor arbitrary URLs in requests.

## Runtime

- Node.js 20+ and TypeScript strict mode;
- Remotion, renderer and bundler pinned to `4.0.516`;
- FFmpeg/ffprobe for exact source proxies and independent output validation;
- Fastify HTTP API;
- SQLite/WAL durable jobs;
- one bounded in-process rendering worker by default.

Install and validate:

```bash
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
```

Normal tests do not start Chromium. The explicit real render is:

```bash
npx remotion browser ensure
npm run smoke:render
```

## Render profile

`youtube_1080p30_v1` is currently the only profile:

- 1920x1080, 30 fps;
- MP4, H.264, yuv420p, CRF 18;
- AAC 192 kbps, 48 kHz;
- `contain` on deterministic black background;
- source gameplay audio removed;
- cut transitions and playback rate 1.0 only;
- final mode rejects every visual gap;
- preview mode shows declared gaps as a black `VISUAL GAP` frame.

Profile identity and all effective encoding settings participate in the render fingerprint.

## API

Start locally after configuring `.env`:

```bash
npm run build
npm start
```

Health and profiles:

```bash
curl http://localhost:8013/health/live
curl http://localhost:8013/health/ready
curl http://localhost:8013/v1/render-profiles
```

Create an asynchronous render:

```bash
curl -X POST http://localhost:8013/v1/renders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: workflow-123-final-v1' \
  -d '{
    "workflow_id": "00000000-0000-4000-8000-000000000000",
    "render_profile": "youtube_1080p30_v1",
    "mode": "final"
  }'
```

```bash
curl http://localhost:8013/v1/renders/RENDER_ID
curl -o video.mp4 http://localhost:8013/v1/renders/RENDER_ID/video
```

The POST reads only the current ProductionTimeline and MediaAsset metadata, snapshots the normalized
manifest and returns HTTP 202. Rendering and downloads happen in the worker. The video endpoint
returns only a completed validated artifact and supports HTTP Range.

Same `Idempotency-Key` and semantics return the same job. Reusing a key after changing timeline,
profile or mode returns 409. Without a key, an equivalent render fingerprint is still reused. Source
SHA-256 identity prevents stale reuse if bytes change behind a stable MediaAsset ID. A completed job
whose output is missing or no longer validates is requeued under the same durable job identity. A
failed deterministic render can be retried by resubmitting the same request without an idempotency
key; equivalent fingerprint resolution requeues that job instead of creating duplicate state.

## Materialization and caches

Narration is downloaded only from the configured Orchestrator
`/workflow/{id}/audio` endpoint. Gameplay metadata/content comes only from configured Media Indexer
`/media-assets/{id}` and `/content` routes. Downloads stream to temporary files, verify SHA-256 and
size, then atomically rename. Per-key filesystem locks and a second cache check prevent concurrent
corruption.

Each exact Stage 15 trim becomes a cached H.264/yuv420p constant-30-fps proxy without audio. Its key
contains source SHA, source microseconds, FPS, codec and proxy strategy. FFprobe validates every new
or reused proxy.

Run retention tools explicitly:

```bash
npm run cache:cleanup
npm run outputs:cleanup
```

Active durable jobs protect their assets. Expired output jobs become explicit `output_expired`
failures rather than retaining a false completed status.

## Determinism and recovery

All Stage 15 seconds are converted once to integer microseconds. Shared boundaries use nearest-frame
half-up rounding; final duration uses ceiling rounding to avoid narration truncation. The manifest,
profile, source identities, component strategy and pinned Remotion version are canonically hashed.

Queued jobs survive restart. Interrupted preparation/render/validation is reconciled only if the
published output passes complete validation; otherwise the same job is requeued. Remotion writes to
a per-job temporary file. The final path appears only after ffprobe, duration/frame, codec, stream,
resolution and checksum validation.

## Docker

```bash
docker compose config
docker compose up --build
```

The container includes pinned Node dependencies, Remotion Headless Shell, FFmpeg and required
Chromium libraries. It runs as a non-root user, has a persistent `/data` volume, a readiness
healthcheck and host-gateway access to Orchestrator/Media Indexer.

## Tooling

```bash
npm run benchmark -- --workflow-id UUID --mode final
npm run benchmark -- --workflow-id UUID --mode final --run
npm run extract:frames -- --input data/outputs/RENDER_ID.mp4
```

The first command is a strict plan; no render request occurs without `--run`. Benchmark output is
JSONL-compatible and includes persisted preparation/render/validation timings,
cache hits, size and render factor. Frame extraction is a debug aid, not Stage 18 visual QA.

An isolated manifest-based resource matrix is also available:

```bash
npm run benchmark:resources -- --manifest /path/to/render-manifest.json \
  --concurrency 1 2 current --output /path/to/benchmark
npm run benchmark:resources -- --manifest /path/to/render-manifest.json \
  --concurrency 1 2 current --output /path/to/benchmark --run
```

Plan mode validates the manifest and starts no bundle, Chromium or render. Real mode writes one MP4
per case and an atomic `report.json` with wall time, render factor, peak RSS for Node plus its Linux
descendants, and system GPU-memory baseline/peak when `nvidia-smi` is available. GPU memory is
explicitly system-scoped, so the operator must exclude unrelated GPU work. This tool never changes
the production `REMOTION_CONCURRENCY` setting.

See [contract details](docs/CONTRACT.md) and [operations](docs/OPERATIONS.md).

## Known limitations

- source type is gameplay only;
- narration is the only final audio;
- no music, SFX, subtitles, branding, overlays or creative transitions;
- no cancellation endpoint until Chromium termination can be guaranteed;
- CPU correctness is supported; no GPU dependency or acceleration assumption;
- real gameplay quality remains blocked by the current Media Indexer dataset;
- Stage 17 automatic workflow-to-render orchestration is intentionally absent.
