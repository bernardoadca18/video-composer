import { z } from 'zod';

const Id = z.string().uuid();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const PositiveSeconds = z.number().finite().positive();
const NonNegativeSeconds = z.number().finite().nonnegative();

export const ClipStrategySchema = z.enum(['USE_DIRECTLY', 'TRIM', 'ADD_CONTEXT']);

export const ClipAudioModeSchema = z.enum(['original', 'mixed', 'replaced']);

export const ClipCaptionModeSchema = z.enum(['none', 'burned', 'sidecar']);

export const ClipRenderRequestSchema = z.object({
  schema_version: z.literal('clip_render_request_v1'),

  clip_composition_id: Id,
  clip_composition_fingerprint: Sha256,
  composition_version: z.number().int().positive(),

  workflow_id: Id,
  source_id: Id,
  plan_id: Id,
  candidate_id: Id,
  analysis_id: Id.nullable(),

  media_id: Id,
  transcription_id: Id,
  source_sha256: Sha256,

  source_start_seconds: NonNegativeSeconds,
  source_end_seconds: PositiveSeconds,

  strategy: ClipStrategySchema,

  render_profile: z.literal('vertical_short_v1'),
  audio_mode: ClipAudioModeSchema,
  caption_mode: ClipCaptionModeSchema,
});

export type ClipRenderRequest = z.infer<typeof ClipRenderRequestSchema>;
export type ClipStrategy = z.infer<typeof ClipStrategySchema>;
export type ClipAudioMode = z.infer<typeof ClipAudioModeSchema>;
export type ClipCaptionMode = z.infer<typeof ClipCaptionModeSchema>;

export class ClipContractValidationError extends Error {
  constructor(
    public readonly category: string,
    message: string,
  ) {
    super(message);
  }
}

export const validateClipRenderRequest = (request: unknown): ClipRenderRequest => {
  const parsed = ClipRenderRequestSchema.parse(request);

  if (parsed.source_end_seconds <= parsed.source_start_seconds) {
    throw new ClipContractValidationError(
      'invalid_clip_contract',
      'source_end_seconds must be greater than source_start_seconds',
    );
  }

  // Strategy is constrained by schema to USE_DIRECTLY | TRIM | ADD_CONTEXT
  // REAUTHOR and REJECT are rejected by schema validation

  if (parsed.audio_mode !== 'original') {
    throw new ClipContractValidationError(
      'unsupported_clip_feature',
      'Only audio_mode=original is supported in clip_render_request_v1',
    );
  }

  if (parsed.caption_mode !== 'none') {
    throw new ClipContractValidationError(
      'unsupported_clip_feature',
      'Only caption_mode=none is supported in clip_render_request_v1',
    );
  }

  return parsed;
};
