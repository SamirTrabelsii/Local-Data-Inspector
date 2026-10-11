import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // LDI_API_PORT lets a second dev API run next to an `ldi` you keep open on 8765.
  const apiPort = loadEnv(mode, '.', '').LDI_API_PORT || '8765'
  return {
    plugins: [react(), tailwindcss()],
    // Served from localhost only, so one bundle is fine.
    build: { chunkSizeWarningLimit: 2000 },
    server: {
      port: 5173,
      proxy: { '/api': `http://127.0.0.1:${apiPort}` },
    },
  }
})
