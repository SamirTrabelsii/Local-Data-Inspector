import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from localhost only, so one bundle is fine.
  build: { chunkSizeWarningLimit: 2000 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
})
