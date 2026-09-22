/**
 * The /api/ipfs pass-through, against a stand-in for pump.fun (nothing is uploaded anywhere).
 *   node indexer/upload.test.mjs
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The stand-in upstream records what it was sent.
let received = null
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const form = await new Request('http://x/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData()
  received = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.size}`]))
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ metadataUri: 'https://ipfs.io/ipfs/stand-in' }))
}).listen(5299)

const PORT = 5298
const child = spawn('node', ['indexer/server.mjs'], { env: { ...process.env, PORT: String(PORT), IPFS_UPSTREAM: 'http://127.0.0.1:5299', INDEXER_DB: '/tmp/pf-upload-test.db', RPC_URL: 'http://127.0.0.1:1' }, stdio: 'ignore' })
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/api/health`); break } catch { await sleep(200) } }

let ip = 0
const post = (file, fields = {}) => {
  const f = new FormData()
  if (file) f.append('file', new Blob([file]), 'x')
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return fetch(`http://127.0.0.1:${PORT}/api/ipfs`, { method: 'POST', body: f, headers: { 'x-forwarded-for': `10.0.0.${++ip}` } })
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)])

let r = await post(PNG, { name: 'Coin', symbol: 'CN', description: 'd', twitter: 'https://x.com/a', evil: 'nope' })
ok('a PNG goes through and the answer comes back', r.status === 200 && (await r.json()).metadataUri === 'https://ipfs.io/ipfs/stand-in')
ok('the known fields are forwarded, an unknown one is dropped', received?.name === 'Coin' && received?.twitter === 'https://x.com/a' && !('evil' in received) && received.file === 'file:108')
ok('the browser can read it (CORS header present)', r.headers.get('access-control-allow-origin') === '*')
r = await post(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { name: 'x' })
ok('an SVG is refused (415)', r.status === 415)
r = await post(Buffer.from('not an image at all'), { name: 'x' })
ok('a non-image with any name is refused (415)', r.status === 415)
r = await post(null, { name: 'x' })
ok('no file is refused (400)', r.status === 400)
r = await post(Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]), { name: 'x' }).catch(() => ({ status: 413 }))
ok('a body over 4 MB is cut off (413)', r.status === 413, String(r.status))
r = await fetch(`http://127.0.0.1:${PORT}/api/ipfs`)
ok('GET is refused (405)', r.status === 405)
{
  const f = () => { const fd = new FormData(); fd.append('file', new Blob([PNG]), 'x'); return fetch(`http://127.0.0.1:${PORT}/api/ipfs`, { method: 'POST', body: fd, headers: { 'x-forwarded-for': '10.9.9.9' } }) }
  const a = await f(), b = await f()
  ok('a second upload from the same IP straight away is throttled (429)', a.status === 200 && b.status === 429, `${a.status} ${b.status}`)
}

child.kill(); upstream.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
