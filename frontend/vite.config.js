import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { gizmagickManifestsPlugin } from './scripts/gizmagick-manifests-plugin.mjs'
import { assertRemoteBuildConfiguration } from '../shared/library-contract.js'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_')
  const source = env.VITE_TRACK_SOURCE || 'legacy'
  assertRemoteBuildConfiguration({ source, command, catalogUrl: env.VITE_GIZMAGICK_CATALOG_URL, mediaBaseUrl: env.VITE_GIZMAGICK_MEDIA_BASE_URL })
  return {
    plugins: [react(), gizmagickManifestsPlugin({
      source,
      publicRoot: fileURLToPath(new URL('./public/', import.meta.url)),
    })],
    server: {
      allowedHosts: [
        'overtime-browse-moonrise.ngrok-free.dev'
      ],
      proxy: {
        '/api/library': {
          target: 'http://127.0.0.1:8787',
        },
        '/ws': {
          target: 'ws://127.0.0.1:8787',
          ws: true
        }
      }
    }
  }
})
