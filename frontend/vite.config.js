import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { gizmagickManifestsPlugin } from './scripts/gizmagick-manifests-plugin.mjs'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), gizmagickManifestsPlugin({
    source: loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_').VITE_TRACK_SOURCE || 'legacy',
    publicRoot: fileURLToPath(new URL('./public/', import.meta.url)),
  })],
  server: {
    allowedHosts: [
      'overtime-browse-moonrise.ngrok-free.dev'
    ],
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true
      }
    }
  }
}))
