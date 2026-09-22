/** Drives vanity-worker.js across several cores and reports progress. */
import { PROGRAM_ID } from './program.mjs'

export const VANITY_SUFFIX = 'fomo'

export function grindInBrowser(saleKey, { suffix = VANITY_SUFFIX, onProgress, signal } = {}) {
  const workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency ?? 4) - 1))
  const CHUNK = 150_000
  const started = Date.now()
  // A random high half of the 64-bit nonce, so the mint cannot be predicted before the launch lands.
  const hi = crypto.getRandomValues(new Uint32Array(1))[0]
  return new Promise((resolve, reject) => {
    let next = 0, tried = 0, done = false
    const pool = []
    const stop = () => pool.forEach((w) => w.terminate())
    signal?.addEventListener('abort', () => { done = true; stop(); reject(new Error('cancelled')) })

    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./vanity-worker.js', import.meta.url), { type: 'module' })
      pool.push(w)
      const feed = () => {
        w.postMessage({ saleKey, programId: PROGRAM_ID.toBase58(), suffix, from: next, count: CHUNK, hi })
        next += CHUNK
      }
      w.onmessage = (e) => {
        if (done) return
        if (e.data.found) {
          done = true; stop()
          return resolve({ ...e.data.found, tried, seconds: (Date.now() - started) / 1000 })
        }
        tried += e.data.tried ?? 0
        onProgress?.(tried, (Date.now() - started) / 1000)
        feed()
      }
      w.onerror = (err) => { if (!done) { done = true; stop(); reject(err) } }
      feed()
    }
  })
}
