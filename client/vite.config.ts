import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-cache-static',
      configureServer(server) {
        const cacheDir = path.resolve(__dirname, '..', 'server', 'cache')

        server.middlewares.use('/local-cache', (req, res, next) => {
          try {
            const rawUrl = req.url || '/'
            const pathname = rawUrl.split('?')[0] || '/'
            const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
            if (!rel || rel.includes('..') || rel.includes('\\')) {
              res.statusCode = 400
              res.end('Bad path')
              return
            }

            const filePath = path.join(cacheDir, rel)
            if (!filePath.startsWith(cacheDir)) {
              res.statusCode = 400
              res.end('Bad path')
              return
            }

            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
              res.statusCode = 404
              res.end('Not found')
              return
            }

            const ext = path.extname(filePath).toLowerCase()
            if (ext === '.png') res.setHeader('Content-Type', 'image/png')
            else if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8')
            else res.setHeader('Content-Type', 'application/octet-stream')
            res.setHeader('Cache-Control', 'no-store')
            fs.createReadStream(filePath).pipe(res)
          } catch (e) {
            next(e)
          }
        })
      },
    },
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
