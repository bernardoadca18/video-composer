import React from 'react';

import type { RenderManifestV3 } from '../../domain/contracts.js';
import { Branding } from './Branding.js';
import { Captions } from './Captions.js';
import { SectionTitles } from './SectionTitles.js';
import { Transitions } from './Transitions.js';

export const PRESENTATION_LAYER_ORDER = [
  'transitions',
  'section_titles',
  'captions',
  'branding',
] as const;

export const PresentationLayers: React.FC<{
  presentation: RenderManifestV3['presentation'];
}> = ({ presentation }) => (
  <>
    <Transitions transitions={presentation.transitions} />
    <SectionTitles titles={presentation.section_titles} />
    <Captions cues={presentation.captions?.cues ?? []} />
    <Branding branding={presentation.branding} />
  </>
);
