import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

// ── Build Version Stamp ──────────────────────────────────────────────────────
// One value computed at the start of every `vite build`. Used two ways:
//
//   1. Injected as the global __BUILD_VERSION__ constant via `define`, so any
//      runtime code can compare it to what's live on the server.
//   2. Written to dist/version.json so the running app can fetch it and
//      auto-reload when a newer build is deployed (see AuthContext.jsx).
//
// ISO-style timestamp keeps it deterministic and human-readable without
// needing git on PATH or in the Vercel build environment.
//
// Example value: "2026-05-11T18-42-07-321Z"
const buildVersion = new Date().toISOString().replace(/[:.]/g, '-')

function buildVersionPlugin() {
  return {
    name: 'rict-build-version',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist')
      try {
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
        writeFileSync(
          path.join(outDir, 'version.json'),
          JSON.stringify(
            { version: buildVersion, builtAt: new Date().toISOString() },
            null,
            2
          )
        )
        console.log(`[Build] version.json written — version=${buildVersion}`)
      } catch (err) {
        // Non-fatal: cache-bust check will simply skip if version.json is missing
        console.error('[Build] Failed to write version.json:', err)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), buildVersionPlugin()],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
  },
})
