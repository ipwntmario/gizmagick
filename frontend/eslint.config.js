import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.track-manifests']),
  {
    files: ['scripts/track-manifests.mjs', 'scripts/gizmagick-*.mjs', 'scripts/lib/*.mjs', 'tests/trackManifest.test.mjs', 'tests/trackRepository.test.mjs', 'tests/library.test.mjs', 'tests/roomPins.test.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', globals: globals.node, sourceType: 'module' },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Storage may be unavailable and audio nodes may already be stopped.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
