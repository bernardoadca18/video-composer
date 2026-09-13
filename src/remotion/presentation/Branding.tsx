import React from 'react';
import { AbsoluteFill } from 'remotion';

import { presentationThemeV1 } from './theme.js';

type BrandingSpec =
  | { preset: 'branding_disabled_v1'; enabled: false }
  | {
      preset: 'text_watermark_v1';
      enabled: true;
      text: string;
      placement: 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right';
      opacity: number;
    };

const placementStyle = (placement: Exclude<BrandingSpec, { enabled: false }>['placement']) => ({
  alignItems: placement.endsWith('left') ? ('flex-start' as const) : ('flex-end' as const),
  justifyContent: placement.startsWith('top') ? ('flex-start' as const) : ('flex-end' as const),
});

export const Branding: React.FC<{ branding: BrandingSpec }> = ({ branding }) => {
  if (!branding.enabled) return null;
  return (
    <AbsoluteFill
      style={{
        ...placementStyle(branding.placement),
        padding: `70px ${presentationThemeV1.safeHorizontal}px`,
        pointerEvents: 'none',
      }}
    >
      <div style={{ ...presentationThemeV1.watermark, opacity: branding.opacity }}>
        {branding.text}
      </div>
    </AbsoluteFill>
  );
};
