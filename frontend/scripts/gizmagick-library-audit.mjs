#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { auditOriginalLibrary, formatLibraryAudit } from './lib/library-import-audit.mjs';

const usage = 'Usage: node scripts/gizmagick-library-audit.mjs [--track "Testing Time"] [--owner-id access:<64 lowercase hex characters>] [--json]\nRead-only local audit with full audio decoding. No cloud access or files written. Exit 1 means local checks failed; even exit 0 does not authorize import/publication.';

try {
  const args = process.argv.slice(2), options = {}, seen = new Set();
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
  } else {
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (seen.has(key) || !['--json', '--track', '--owner-id'].includes(key)) throw new Error(usage);
      seen.add(key);
      if (key === '--json') options.json = true;
      else {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(usage);
        options[key === '--track' ? 'track' : 'ownerId'] = value;
      }
    }
    const report = await auditOriginalLibrary({
      publicRoot: fileURLToPath(new URL('../public/', import.meta.url)),
      ownerId: options.ownerId, track: options.track,
      onTrack: item => console.error(`Audited ${item.legacyKey}: ${item.localChecksPassed ? 'PASS' : 'FAIL'}`),
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatLibraryAudit(report));
    if (report.totals.failedTracks) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
