/**
 * The landing's field.
 *
 * ## The idea
 *
 * The ridgelines are not decoration. Each one is pump.fun's constant-product curve —
 * `price = vs² / k`, the same formula the program prices every deposit with — drawn at a
 * different depth and scale. The horizon a visitor is looking at IS the thing the product does,
 * which is why this is generated rather than a stock image: no photograph of a mountain could be
 * about a bonding curve, and a decorative swoosh would be a lie about where the shape came from.
 *
 * Above it, embers rise from the curve like deposits landing in a window, drifting and fading.
 *
 * ## Why canvas and not gradients
 *
 * Layered CSS radials cannot do depth-of-field, grain, or motion that reads as atmosphere rather
 * than as a slideshow. They also cannot be *about* anything.
 *
 * ## The care that makes it cheap
 *
 * - Device-pixel-ratio aware, capped at 2 — a 3x phone would otherwise render 9x the pixels for
 *   a background nobody is inspecting.
 * - Capped near 30fps. This is a slow-moving field; 60 would double the power draw to no visible
 *   end.
 * - Pauses entirely when the tab is hidden or the hero scrolls out of view, so a landing left
 *   open in a background tab costs nothing.
 * - `prefers-reduced-motion` draws ONE frame and stops. The composition is designed to be worth
 *   looking at standing still, because for some people it always will be.
 */
import { useEffect, useRef } from 'react'

const BG = '#06070e'
const MINT = [102, 216, 150]
const PERI = [228, 228, 252]

const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`

/**
 * A ridge, sampled from the curve itself.
 *
 * `vs` and `vt` are the virtual reserves; price is vs²/k. Sweeping x across the width advances
 * the reserves, so the profile that comes out is the real ascent a sale walks up, not a sine
 * wave dressed as one. `lift` and `squash` place it in the scene.
 */
function ridgePath(ctx, w, h, { baseline, amp, phase, squash }) {
  const VS0 = 30, VT0 = 1073
  const k = VS0 * VT0
  ctx.beginPath()
  ctx.moveTo(0, h)
  const steps = Math.max(48, Math.round(w / 12))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // Advance along the curve, offset per layer so the ranges do not sit on top of each other.
    const x = t * w
    const solIn = (t + phase) * 62 * squash
    const vs = VS0 + solIn
    const price = (vs * vs) / k          // rises convexly, the ascent the product is about
    const norm = (price - (VS0 * VS0) / k) / (((VS0 + 62) * (VS0 + 62)) / k - (VS0 * VS0) / k)
    const y = baseline - norm * amp
    ctx.lineTo(x, y)
  }
  ctx.lineTo(w, h)
  ctx.closePath()
}

export default function Sky() {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let running = true
    let w = 0, h = 0, dpr = 1

    // Embers. Seeded once so the field is stable across frames rather than sparkling randomly.
    const EMBERS = 46
    const embers = Array.from({ length: EMBERS }, (_, i) => ({
      x: (i * 97) % 100 / 100,
      y: ((i * 53) % 100) / 100,
      r: 0.6 + ((i * 31) % 10) / 10 * 1.5,
      sp: 0.12 + ((i * 17) % 10) / 10 * 0.34,
      a: 0.16 + ((i * 23) % 10) / 10 * 0.4,
      peri: i % 4 === 0,
    }))

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(2, window.devicePixelRatio || 1)
      w = Math.max(1, Math.round(rect.width))
      h = Math.max(1, Math.round(rect.height))
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const draw = (time) => {
      const t = time / 1000

      // ── sky ────────────────────────────────────────────────────────────────────────────────
      const sky = ctx.createLinearGradient(0, 0, 0, h)
      sky.addColorStop(0, BG)
      sky.addColorStop(0.40, '#070a12')
      sky.addColorStop(0.66, '#0e1a2740')   // the band the ridges are lit against
      sky.addColorStop(1, '#0c1622')
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, w, h)

      // ── aurora: three slow lights, drifting on different periods so they never visibly loop ──
      const lights = [
        { cx: 0.5 + Math.sin(t * 0.043) * 0.07, cy: 0.63, r: 0.40, c: MINT, a: 0.34 },
        { cx: 0.17 + Math.cos(t * 0.031) * 0.05, cy: 0.66, r: 0.30, c: PERI, a: 0.16 },
        { cx: 0.86 + Math.sin(t * 0.037) * 0.05, cy: 0.64, r: 0.28, c: MINT, a: 0.15 },
      ]
      for (const l of lights) {
        const g = ctx.createRadialGradient(l.cx * w, l.cy * h, 0, l.cx * w, l.cy * h, l.r * Math.max(w, h))
        g.addColorStop(0, rgba(l.c, l.a))
        g.addColorStop(1, rgba(l.c, 0))
        ctx.fillStyle = g
        ctx.fillRect(0, 0, w, h)
      }

      // ── embers, behind the ridges so the front range occludes them ─────────────────────────
      for (const e of embers) {
        const y = (e.y - ((t * e.sp * 0.03) % 1) + 1) % 1
        const py = 0.30 * h + y * 0.55 * h
        const px = e.x * w + Math.sin(t * 0.18 + e.y * 9) * 14
        const fade = Math.sin(y * Math.PI)          // dim at both ends of the drift
        ctx.beginPath()
        ctx.arc(px, py, e.r, 0, Math.PI * 2)
        ctx.fillStyle = rgba(e.peri ? PERI : MINT, e.a * fade * 0.85)
        ctx.fill()
      }

      // ── the ranges: far to near, each lighter-to-darker with a lit edge ────────────────────
      const ranges = [
        { baseline: 0.72, amp: 0.26, phase: 0.55, squash: 0.55, fill: '#0a1220', edge: rgba(PERI, 0.26), lw: 1.2 },
        { baseline: 0.86, amp: 0.34, phase: 0.28, squash: 0.78, fill: '#060a13', edge: rgba(MINT, 0.42), lw: 1.4 },
        { baseline: 1.06, amp: 0.44, phase: 0.05, squash: 1.0,  fill: '#020409', edge: rgba(MINT, 0.75), lw: 1.7 },
      ]
      for (const r of ranges) {
        ridgePath(ctx, w, h, { baseline: r.baseline * h, amp: r.amp * h, phase: r.phase, squash: r.squash })
        ctx.fillStyle = r.fill
        ctx.fill()
        // The rim reads as light catching the ridge; without it the fills merge into one mass.
        ctx.save()
        ctx.strokeStyle = r.edge
        ctx.lineWidth = r.lw
        ctx.shadowColor = r.edge
        ctx.shadowBlur = r.lw * 9
        ctx.stroke()
        ctx.restore()
      }

      // ── grain. Filmic, and it hides the banding a wide dark gradient always shows ──────────
      ctx.globalAlpha = 0.022
      for (let i = 0; i < 900; i++) {
        const gx = (i * 7919) % w
        const gy = (i * 104729) % h
        ctx.fillStyle = i % 2 ? '#ffffff' : '#000000'
        ctx.fillRect(gx, gy, 1, 1)
      }
      ctx.globalAlpha = 1

      // ── scrim: the ground fades in at the top so the header floats rather than sits on art ──
      const scrim = ctx.createLinearGradient(0, 0, 0, h)
      scrim.addColorStop(0, BG)
      scrim.addColorStop(0.14, 'rgba(6, 7, 14, 0.55)')
      scrim.addColorStop(0.42, 'rgba(6, 7, 14, 0)')
      scrim.addColorStop(0.88, 'rgba(6, 7, 14, 0.45)')
      scrim.addColorStop(1, BG)
      ctx.fillStyle = scrim
      ctx.fillRect(0, 0, w, h)
    }

    // ~30fps is plenty for a field that drifts. Sixty would double the power for no visible gain.
    let last = 0
    const loop = (time) => {
      if (!running) return
      if (time - last >= 33) { last = time; draw(time) }
      raf = requestAnimationFrame(loop)
    }

    resize()
    // ⚠ ALWAYS paint one frame, synchronously, before any of the pause logic can run. The field
    // existing is not conditional on the field moving: the observers below stop the LOOP, and an
    // earlier version let them stop the first paint too, so a page loaded while the tab was
    // hidden — a background tab, a restored session — showed a blank black rectangle until
    // something happened to wake it. Motion is the optional part.
    draw(0)
    if (!reduced) raf = requestAnimationFrame(loop)

    const onResize = () => { resize(); draw(performance.now()) }
    window.addEventListener('resize', onResize)

    // ⚠ A window resize listener alone is not enough: the first measure runs before layout has
    // settled, so the backing store was sized to a stale rect and the art rendered soft and
    // cropped. Observing the element catches that first correction, and any later layout change
    // that never fires a window resize.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null
    ro?.observe(canvas)

    // Stop entirely when nobody is looking — a hidden tab or a scrolled-past hero costs nothing.
    const setRunning = (next) => {
      if (next === running) return
      running = next
      if (running && !reduced) { last = 0; raf = requestAnimationFrame(loop) }
      else { cancelAnimationFrame(raf); draw(performance.now()) }
    }
    const onVis = () => setRunning(!document.hidden)
    document.addEventListener('visibilitychange', onVis)

    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([e]) => setRunning(e.isIntersecting && !document.hidden), { threshold: 0 })
      : null
    io?.observe(canvas)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      io?.disconnect()
      ro?.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="sky" aria-hidden="true" />
}
