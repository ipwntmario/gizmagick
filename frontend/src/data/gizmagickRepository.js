import checkStructure from 'virtual:gizmagick-manifest-validator';
import { validateManifestWithStructure } from '../../../shared/track-manifest.js';
import { createTrackRepository } from './trackRepository.js';

export const gizmagickRepository = createTrackRepository({
  source: import.meta.env.VITE_TRACK_SOURCE || 'legacy',
  remoteCatalogUrl: import.meta.env.VITE_GIZMAGICK_CATALOG_URL,
  mediaBaseUrl: import.meta.env.VITE_GIZMAGICK_MEDIA_BASE_URL,
  validateManifest: manifest => validateManifestWithStructure(manifest, checkStructure),
});
