import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// Development only: `vite build` ignores everything under `server`, so none of
// this reaches a deployed build. The proxy lets the browser talk to one origin
// while developing, so an https tunnel (ngrok) works without mixed-content
// blocks, CORS, or the phone trying to resolve "localhost" as itself. It is
// used only when the VITE_*_BASE_URL variables are empty.
const API_TARGET = process.env.VITE_DEV_API_TARGET || 'http://localhost:8080'
const API_PATHS = ['/auth', '/groups', '/rides', '/sos', '/health']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(),],
  server: {
    // Listen on the LAN too, not just 127.0.0.1.
    host: true,
    // Vite rejects unknown Host headers, so the tunnel's name is allowed here.
    allowedHosts: ['treadmill-labored-avenue.ngrok-free.dev'],
    proxy: {
      ...Object.fromEntries(
        API_PATHS.map((path) => [path, { target: API_TARGET, changeOrigin: true }]),
      ),
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
})
