import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }
// The GitHub Pages demo has no API server, so account and cloud sync are hidden.
const staticDemo = process.env.STATIC_DEMO === '1'

export default defineConfig({
  base: staticDemo ? '/WEB_DisplayMaker_esp32/' : '/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __STATIC_DEMO__: JSON.stringify(staticDemo),
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4174',
        changeOrigin: false,
      },
    },
  },
})
