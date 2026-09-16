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
- `data/cache/music`: checksum-validated controlled WAV/FLAC sources;
- `data/cache/program-audio`: normalized music, pre-master mix, and mastered 48 kHz stereo PCM,
  each protected by SHA/size sidecars and locks;
- `data/cache/proxies`: exact-trim, 30 fps, silent H.264 proxies;
- `data/work`: per-render temporary data;
- `data/outputs`: validated public MP4 files;
- `data/db`: SQLite/WAL state.

Run `npm run cache:cleanup` to enforce age/size limits. Artifacts referenced by active durable jobs
are protected. Run `npm run outputs:cleanup` to expire old completed outputs; the job becomes an
explicit `output_expired` failure rather than claiming a missing file is completed.

The cache catalog records atomic verified entries, byte size, SHA, stat identity, integrity state and
last access. Normal source hot hits therefore avoid rehashing multi-gigabyte files, but changed or
suspicious entries are rehashed before reuse. LRU is driven by access time; active/recoverable render
assets are never eviction candidates.

## Capacity and incident smoke

The worker requires a positive disk plan before source work. It reserves `DISK_SAFETY_RESERVE_BYTES`
(10 GiB by default) in addition to the predicted missing source bytes, V2 derivative bytes, atomic
temporary-file allowance, Remotion intermediate allowance and final output allowance. Increase the
reserve instead of raising static cache ceilings on machines with limited disks.

Use a bounded smoke before a real retry:

```bash
npm run smoke:window -- --render-id RENDER_ID --frame 2479 --before 60 --after 60
```

This command is intentionally read-only with respect to production job state: it does not requeue,
retry, regenerate upstream artifacts or start the full render. It requires the target job's proxies
to exist and otherwise fails with their keys.

## Failure handling

Dependency, proxy, Remotion/Chromium, FFmpeg, validation and storage failures have separate public
categories. Public responses omit host paths and stack traces; contextual logs contain render ID,
workflow, phase, frame progress and timings. No provider call has hidden retries.

Cancellation is deliberately deferred until Remotion process termination can be guaranteed without
leaking Chromium children. Queue overload returns HTTP 429.

Program Audio keeps invalid plan, unavailable/integrity-failed music, mix, master, and output
validation failures distinct. Remotion renders video-only; final mux copies H.264 and performs the
only AAC encode from lossless PCM. Corrupt derivatives are rebuilt atomically. Structured events
carry render/asset/plan identities and pre/post master measurements without host paths.

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

`tests/fixtures/production_timeline_v2_contract.json` is the canonical small cross-service
contract fixture, mirrored byte-for-byte in the Orchestrator tests. It must continue to parse as
`video_segment -> static_image`; enum, MIME, or source-union drift is expected to fail CI before
reaching a render worker.

## Presentation smoke (run after corpus ingestion)

The prepared synthetic smoke combines video → image → video → image with narration, captions, one
explicit section title, the synthetic text-watermark preset, and one fade-to-black boundary:

    npm run build
    SMOKE_HYBRID=1 SMOKE_PRESENTATION=1 npm run smoke:render

It is intentionally not part of unit tests because it starts Chromium and FFmpeg. While Media
Indexer corpus ingestion is active, leave this command pending. After ingestion, inspect
data/smoke/presentation-engine-render.mp4 and the adjacent JSON report, including H.264, 1920x1080,
30 fps, yuv420p, one AAC 48 kHz stream, expected duration/frame count, sampled overlay frames,
second-run cache reuse, and stable fingerprints.

## Program Audio smoke and A/B review

```bash
SMOKE_HYBRID=1 SMOKE_PRESENTATION=1 SMOKE_PROGRAM_AUDIO=1 npm run smoke:render
```

The generated synthetic smoke verifies V4, H.264/yuv420p, one AAC 48 kHz stereo stream, silent
gameplay proxies, music presence, measured ducking, fades, program LUFS/True Peak, presentation,
stable identities, and cache reuse in a second job. Review artifacts are under
`data/smoke/program-audio-review`: narration only, pre-master mix, final PCM master, and a manifest
with SHAs/policies/measurements. Candidate gain and mastering values are not human-frozen.
