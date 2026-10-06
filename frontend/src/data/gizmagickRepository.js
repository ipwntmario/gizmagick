import checkStructure from 'virtual:gizmagick-manifest-validator';
import { validateManifestWithStructure } from '../../../shared/track-manifest.js';
import { createTrackRepository } from './trackRepository.js';

export const gizmagickRepository = createTrackRepository({
  source: import.meta.env.VITE_TRACK_SOURCE || 'legacy',
  validateManifest: manifest => validateManifestWithStructure(manifest, checkStructure),
});
