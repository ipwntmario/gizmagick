import { createLocalLibrarySnapshot, createManifestValidatorSource } from './lib/gizmagick-local-library.mjs';

const validatorModule = 'virtual:gizmagick-manifest-validator';
const resolvedValidator = `\0${validatorModule}`;

export function gizmagickManifestsPlugin({ source, publicRoot }) {
  if (!['legacy', 'manifest'].includes(source)) throw new Error(`Unknown VITE_TRACK_SOURCE: ${source}. Use legacy or manifest.`);
  let snapshot;
  let building = false;
  return {
    name: 'gizmagick-local-manifests',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) { if (id === validatorModule) return resolvedValidator; },
    load(id) {
      if (id === resolvedValidator) return source === 'manifest' ? createManifestValidatorSource() : 'export default null;';
    },
    async buildStart() {
      if (source !== 'manifest' || !building) return;
      snapshot = await createLocalLibrarySnapshot(publicRoot);
      for (const [url, document] of snapshot.documents) {
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: document });
      }
    },
    async configureServer(server) {
      if (source !== 'manifest') return;
      // A dev server keeps a single catalog/version snapshot. Restart after
      // musical data changes, just as for changes to VITE_TRACK_SOURCE.
      snapshot = await createLocalLibrarySnapshot(publicRoot);
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (!pathname.startsWith('/gizmagick-tracks/')) return next();
        const document = snapshot.documents.get(pathname);
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(request.method)) {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end(JSON.stringify({ error: 'Method not allowed' }));
        } else if (document === undefined) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Gizmagick manifest not found' }));
        } else response.end(request.method === 'HEAD' ? undefined : document);
      });
    },
  };
}
