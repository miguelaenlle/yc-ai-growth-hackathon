import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Backend runs on :3001 — proxy API calls there in dev so the frontend can
// hit relative paths (e.g. fetch('/calls')).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/calls': 'http://localhost:3001',
      '/trees': 'http://localhost:3001',
      '/recordings': 'http://localhost:3001',
      '/stream': 'http://localhost:3001',
      '/transcribe': 'http://localhost:3001',
      '/agent': 'http://localhost:3001',
      '/mock': 'http://localhost:3001',
      '/tts': 'http://localhost:3001',
      '/data': 'http://localhost:3001',
    },
  },
})
