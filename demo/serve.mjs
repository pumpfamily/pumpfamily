// Serves demo/ with CORS on :5242, so the site on :5240 can fetch demo metadata and images.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
const TYPES = { json: 'application/json', svg: 'image/svg+xml' }
createServer(async (req, res) => {
  const name = req.url.split('?')[0].replace(/^\/+/, '')
  try {
    if (!/^[\w.-]+$/.test(name)) throw new Error('bad path')
    const body = await readFile(new URL(`./${name}`, import.meta.url))
    res.writeHead(200, { 'content-type': TYPES[name.split('.').pop()] ?? 'application/octet-stream', 'access-control-allow-origin': '*' })
    res.end(body)
  } catch { res.writeHead(404, { 'access-control-allow-origin': '*' }); res.end() }
}).listen(5242, '127.0.0.1', () => console.log('demo metadata on http://localhost:5242'))
