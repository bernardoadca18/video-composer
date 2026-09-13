# Stage 16 input and output contract

## Accepted upstream artifact

The service reads the coherent internal package
GET /workflow/{workflow_id}/composer-render-input. The package contains a frozen
ProductionTimeline plus an optional PresentationSpec. The legacy timeline endpoint remains an
Orchestrator API, but the Composer does not assemble presentation by making independent reads.

The Composer supports:

- schemas production_timeline_schema_v1 and production_timeline_schema_v2;
- status `completed` or `completed_with_gaps`;
- source type `gameplay`;
- playback rate `1.0`;
- transition `cut`;
- half-open `[start,end)` second ranges;
- one complete narration track starting at zero.

Timeline seconds remain authoritative. Candidate ranges authorize footage; exact source ranges are
the only visible gameplay interval. These fields are never interchanged.

## Quantization

Stage 15 seconds are converted once to integer microseconds. Every unique shared boundary is mapped
once using nearest-frame, half-up rounding. Frame zero is fixed. Final duration uses ceiling rounding
so narration is not truncated. Any placement or gap collapsing to zero frames is rejected.

## Render manifest

`render_manifest_v1` is a normalized immutable snapshot containing timeline identity, profile,
source SHA-256 identities, exact source microseconds, frame ranges, proxy keys and controlled local
asset URLs. Its canonical SHA-256 differs from the upstream ProductionTimeline fingerprint.

render_manifest_v2 preserves the hybrid video_segment | static_image source contract.
render_manifest_v3 is emitted only when a valid presentation_spec_v1 is present. It retains the
V1/V2 source semantics, records the source timeline schema, validates the PresentationSpec
fingerprint, and quantizes every overlay boundary to frames before rendering. Caption, title,
branding, or transition changes therefore change manifest and render identity. A missing
PresentationSpec follows the original V1/V2 code path and identity unchanged.

## Output guarantee

`youtube_1080p30_v1` produces MP4, 1920x1080, 30 fps, H.264/yuv420p and exactly one AAC 48 kHz
narration stream. Visual fit is `contain` on black. Final mode rejects all gaps; preview mode renders
declared gaps as deterministic black diagnostic frames. Output duration stays within one frame of
the authoritative timeline.

Unsupported future source types, transitions or playback rates fail explicitly. The Composer never
selects an alternative source.

# Hybrid timeline V2

In addition to the existing `production_timeline_schema_v1`/`gameplay` input, the Composer
accepts `production_timeline_schema_v2` with a strict `video_segment | static_image` union.
Video segments retain real candidate and trim ranges with playback rate 1. Static images carry
logical project/media/ImageSemanticIndex identity, expected SHA-256, byte size and image MIME,
and explicitly carry no session or source time.

V2 produces `render_manifest_v2` (`video_composer_v2_hybrid_sources`). Image placements include
the frozen presentation selected upstream: `cover|contain`, `black|blurred_fill`, and
`none|slow_zoom_in|slow_zoom_out`. Holds are timeline time and quantize through the same shared
frame-boundary algorithm as video. Final renders remain gap-free and source audio remains muted.

The Orchestrator owns editorial hold policy (currently 2 s minimum, 5 s preferred, 8 s maximum,
and 15 s maximum consecutive still duration) and freezes its result in Timeline V2. The Composer
does not duplicate or reinterpret those tunable limits: it validates positive, non-overlapping,
frameable placements plus the strict source/presentation/integrity contract, then renders exactly
the approved hold.

# PresentationSpec V1

Presentation is a strict overlay contract owned and resolved by the Orchestrator:

- captions use only timestamped words from the transcription tied to the final narration SHA;
- section titles use only explicit display_title values preserved from editorial planning;
- branding is a closed preset union (branding_disabled_v1 or the bounded synthetic
  text_watermark_v1 contract);
- cuts remain timeline default; fade_to_black is the only V1 overlay transition and never changes
  source ranges or total duration.

The long-form profile uses caption_policy_v1, subtle_longform_v1, minimal_section_v1,
branding_disabled_v1, and section_boundary_fade_v1. Upstream can provide no paths, URLs, base64,
HTML, CSS, or asset payloads. Unknown keys/presets, non-finite or overlapping ranges, captions
beyond two 42-character lines, stale audio identity, and overlays outside duration fail closed.

Remotion layer order is primary visual (including existing static-image presentation), preview-gap
diagnostics, transition overlay, section title, captions, branding, and the single narration audio
track. The Composer performs no ASR, LLM call, segmentation, title invention, or visual selection.
