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

// Some API prefixes double as app routes (/groups), so a page refresh would be
// proxied to the API and come back as JSON. Browser navigations ask for HTML;
// serve those the SPA and let only fetch/XHR calls reach the backend.
const bypassPageLoads = (req) =>
  req.headers.accept?.includes('text/html') ? '/index.html' : undefined

// Prints what src/utils/devLog.ts posts from the browser, so logs from a
// phone show up in this terminal.
const browserLogs = () => ({
  name: 'browser-logs',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__log', (req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const { event, data } = JSON.parse(body)
          const time = new Date().toLocaleTimeString()
          console.log(`\x1b[36m[browser ${time}] ${event}\x1b[0m`, data === undefined ? '' : JSON.stringify(data))
        } catch {
          console.log('[browser]', body)
        }
        res.statusCode = 204
        res.end()
      })
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), browserLogs()],
  server: {
    // Listen on the LAN too, not just 127.0.0.1.
    host: true,
    // Vite rejects unknown Host headers, so the tunnel's name is allowed here.
    allowedHosts: ['treadmill-labored-avenue.ngrok-free.dev'],
    proxy: {
      ...Object.fromEntries(
        API_PATHS.map((path) => [path, { target: API_TARGET, changeOrigin: true, bypass: bypassPageLoads }]),
      ),
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
    },
  },
})
