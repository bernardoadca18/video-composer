# Operations

The service is a trusted-network, single-node renderer. TLS, authentication and external
rate-limiting are required before public exposure.

## Job recovery

SQLite is the durable source of job state. Queued jobs are re-enqueued after restart. Jobs left in
asset preparation, rendering or validation are reconciled to completed only when the deterministic
final path passes full ffprobe validation; otherwise the partial artifact is deleted and the same
job/fingerprint is requeued.

## Storage

- `data/cache/source`: content-addressed Media Indexer downloads;
- `data/cache/narration`: checksum-validated WAVs;
- `data/cache/proxies`: exact-trim, 30 fps, silent H.264 proxies;
- `data/work`: per-render temporary data;
- `data/outputs`: validated public MP4 files;
- `data/db`: SQLite/WAL state.

Run `npm run cache:cleanup` to enforce age/size limits. Artifacts referenced by active durable jobs
are protected. Run `npm run outputs:cleanup` to expire old completed outputs; the job becomes an
explicit `output_expired` failure rather than claiming a missing file is completed.

## Failure handling

Dependency, proxy, Remotion/Chromium, FFmpeg, validation and storage failures have separate public
categories. Public responses omit host paths and stack traces; contextual logs contain render ID,
workflow, phase, frame progress and timings. No provider call has hidden retries.

Cancellation is deliberately deferred until Remotion process termination can be guaranteed without
leaking Chromium children. Queue overload returns HTTP 429.

## Container render smoke

The smoke harness can target an already-running Composer while hosting controlled synthetic
Orchestrator/Media Indexer responses on the host. Configure the container dependency URLs to
`http://host.docker.internal:18014`, then run:

```bash
SMOKE_EXTERNAL_COMPOSER_URL=http://127.0.0.1:8013 \
SMOKE_UPSTREAM_HOST=0.0.0.0 \
npm run smoke:render
```

This exercises Remotion, Chromium, FFmpeg, SQLite, caches and output validation inside the built
image. The default smoke still starts an isolated host process when those variables are absent.

# Hybrid smoke

Run the deterministic local four-source smoke after building:

```bash
npm run build
SMOKE_HYBRID=1 npm run smoke:render
```

It generates local narration, a synthetic video with audio, portrait and landscape PNGs, then
renders video → image → video → image. The review artifact is retained at
`data/smoke/hybrid-engine-render.mp4`; JSON metrics are written beside it. A second render proves
narration/source/proxy cache reuse. No external provider or operator media is accessed.

Images are streamed from the managed source cache and rendered directly by Remotion. They are
not expanded into frame sequences or intermediate MP4s. Metadata and content must agree on
logical ID, project, `media_kind=image`, MIME, byte size, and SHA-256.
