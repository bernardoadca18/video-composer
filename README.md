# NeoVids Video Composer

Stage 16 deterministic rendering service. It converts the frozen Orchestrator
`ProductionTimeline` into a validated MP4 without making editorial decisions.

```text
ProductionTimeline
  -> validated RenderManifest
  -> proxy-first derivative plan over trusted HTTP assets
  -> coalesced silent, seek-friendly render proxies
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

The V2 proxy profile (`render_proxy_1080p30_v2`) is content-addressed by every material encoder
decision: source SHA/range, dimensions, scale/no-upscale policy, FPS, codec/backend, pixel format,
CRF, preset, GOP/scenecut, color policy and strategy version. For the 1080p profile it generates a
silent H.264/yuv420p fit-inside proxy at no more than 1920×1080, strips metadata/data streams, and
uses fixed two-second GOPs. Overlapping or suitably adjacent intervals from one source are coalesced;
each placement keeps its original source range and a frame-accurate offset into the derivative.

The worker plans and validates proxies before source materialization. A warm hit performs no source
download; missing derivatives are grouped by source and processed serially. Cache validation uses a
fast ffprobe path. Source/narration/music hot hits use the durable cache catalog plus stat identity;
full SHA verification remains mandatory on write, metadata change, suspicious cache state and explicit
deep validation. Cache access updates LRU recency and active jobs remain protected from cleanup.

Before heavy asset work, the worker calculates a disk plan containing free space, source/proxy/temp,
Remotion/output allowances and a 10 GiB reserve. A definitely insufficient plan fails as
`insufficient_disk_capacity` before downloading source media.

`HTTP_TIMEOUT_MS` bounds control-plane requests and the wait for asset response headers.
`ASSET_DOWNLOAD_IDLE_TIMEOUT_MS` is a separate data-plane inactivity limit: a large transfer may
run longer than the control timeout while bytes keep arriving, but is aborted after that much time
without progress. Every asset is restricted to its immutable expected byte size (legacy narration
without a declared size has a 2 GiB ceiling), and incomplete temporary files are removed instead of
being promoted into the cache.

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

To reproduce a bounded Remotion incident smoke without starting a full retry, use a durable render
whose V2 proxies have already been prepared:

```bash
npm run smoke:window -- --render-id RENDER_ID --frame 2479 --before 60 --after 60
```

It renders only the selected frame window and reports the frame range, wall time and renderer progress.
On a Remotion failure, private structured diagnostics identify the frame, timeline time, placement,
source SHA, proxy key, local placement offset, proxy dimensions/duration and renderer phase; public
responses stay sanitized.

See [contract details](docs/CONTRACT.md) and [operations](docs/OPERATIONS.md).

## Known limitations

- source type is gameplay only;
- narration is the only final audio;
- no music, SFX, subtitles, branding, overlays or creative transitions;
- no cancellation endpoint until Chromium termination can be guaranteed;
- CPU correctness is supported; no GPU dependency or acceleration assumption;
- real gameplay quality remains blocked by the current Media Indexer dataset;
- Stage 17 automatic workflow-to-render orchestration is intentionally absent.

### Bounded derivative preparation and frame smoke

Use an existing render ID. These commands read the job without requeueing it and
limit the smoke to a proper subset of at most 301 frames. Full-source fallback
must remain disabled. Only intersecting proxy keys are materialized using the
production derivative resolver, integrity checks and proxy inspection.

```bash
npm run prepare:window -- --render-id UUID --frame 2479 --before 60 --after 60
npm run smoke:window -- --render-id UUID --frame 2479 --before 60 --after 60
```

If the saved job uses the historical proxy strategy, pass `--refresh-manifest true`
to preparation. This reads the frozen render-input from the Orchestrator and uses
the current production manifest builder. It saves a detached snapshot under
`DATA_ROOT/work/smoke`, with both historical and current fingerprints. It never
creates or modifies a production render job. Pass the reported snapshot path via
`--prepared-manifest PATH` to the smoke. Its lineage, fingerprint and window are
validated before rendering. A later authorized production render can have a new
ID because its technical strategy changed.

Preparation writes a `.preparation.json` report with actual HTTP paths, received
body bytes, derivative metadata and proxy hits/misses. These are bounded-smoke
observations, not full-render job metrics. No worker or full-source resolver is
constructed. Run one preparation/smoke at a time.
