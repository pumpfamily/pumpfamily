/**
 * The presale's price chart.
 *
 * ## Why a presale has a price at all
 *
 * Each deposit is booked at the shadow curve's state when it lands, which is the same constant
 * product pump.fun's bonding curve uses. So a sale in progress is not a pot of money waiting for a
 * price — it already HAS one, and it moves with every deposit exactly as it will once the coin
 * trades. This chart is that movement, and it is continuous with the coin's real chart: the launch
 * buys the summed tokens in one transaction, which lands the curve on the last point drawn here.
 *
 * ## The y axis is market cap, not price
 *
 * Price per token at the open is 2.8e-8 SOL — a number nobody reads. Market cap over the same
 * curve runs 27.96 SOL at the open to 410.4 SOL at graduation, which is both legible and the
 * figure pump.fun and every chart site actually display.
 *
 *   mcap = price × supply = (vs / vt) × TOTAL, and vs·vt is invariant, so vt = k/vs
 *        = vs² / k × 10^6   (lamports and base units to SOL and whole tokens)
 *
 * ## What it deliberately does NOT draw
 *
 * Nothing after the launch point. Where the price goes once the public can trade is unknown, and a
 * speculative line on a chart people are deciding to put money into would be a forecast dressed as
 * data. The last point is where it opens; the caption says so and stops there.
 *
 * ## The one number that is authoritative
 *
 * Every point here comes from a replayed `Deposited` log stream, which can have gaps — see the
 * warning in `indexer/events.mjs`. `nowMarketCap` is passed in from the SALE ACCOUNT, which cannot
 * be stale, and is drawn as the final point. A missed deposit in the middle costs some shape; it
 * never moves the price a depositor is actually looking at.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
/**
 * ⚠ The market-cap arithmetic lives in `curve.mjs`, not here — it is denomination-dependent in
 * two separate places (the curve's `k` AND the trailing supply factor), it has been got wrong
 * more than once, and only the shared module has tests. This file draws it; it does not define
 * it. See the block comment there.
 */
import {
  marketCap, marketCapFromSold, openMarketCap, unitOf,
  usdMarketCap, fmtUsdCap,
} from './curve.mjs'

export { marketCap, marketCapFromSold, unitOf }

const fmtSol = (n) => n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)
/**
 * Time formatted for the span being shown.
 *
 * A fixed HH:MM labelled both ends of a 28-second window `01:33`, which reads as a broken axis
 * rather than a short one. A window can be minutes or days, so the format has to follow it.
 */
function fmtTime(t, span = 0) {
  const d = new Date(t * 1000)
  if (span > 86400) return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (span < 3600) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Geometry measured in CSS pixels, not a fixed viewBox.
 *
 * An SVG with a 720-wide viewBox scaled into a 322px phone column scales EVERYTHING, text
 * included: 11px axis labels landed at about 5px and could not be read. Measuring the container
 * and drawing at 1:1 keeps every label the size it says it is, at any width.
 */
function useWidth(fallback = 720) {
  const [w, setW] = useState(fallback)
  const el = useRef(null)
  // One stable callback: a fresh ref function each render makes React detach and reattach on
  // every pass, which re-measures for no reason.
  const ref = useCallback((node) => {
    el.current = node
    if (node) setW(node.getBoundingClientRect().width || fallback)
  }, [fallback])
  useEffect(() => {
    const node = el.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width || fallback))
    ro.observe(node)
    return () => { ro.disconnect() }
  }, [fallback])
  return [w, ref]
}

const geometry = (w) => {
  const narrow = w < 460
  const H = narrow ? 190 : 250
  const PAD = { top: 16, right: narrow ? 8 : 16, bottom: 26, left: narrow ? 40 : 52 }
  return { W: w, H, PAD, PLOT: { w: w - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom }, narrow }
}

/**
 * Ticks that land on round numbers rather than on the data's exact extremes.
 *
 * A axis labelled 27.96 / 33.18 / 38.40 is arithmetically correct and unreadable; people read a
 * chart against round values.
 */
function ticks(lo, hi, count = 4) {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v)
  return out
}

/**
 * ⛔⛔ TWO units, not one.
 *
 * A Pump Family coin is bought with USDC and trades on a SOL curve, so a single `quoteLabel`
 * cannot describe this chart: the market caps are SOL and the amounts people paid are USDC.
 * Passing one label for both drew a 30-SOL curve as 30 billion USDC — wrong by the SOL price, and
 * shaped like a real number.
 *
 *  - `curveQuote` scales the curve, the market caps and every cap label.
 *  - `payQuote` is only the decimals and unit of what a buyer actually sent.
 */
export default function Chart({ deposits, nowMarketCap, symbol, curveQuote = 'sol', payQuote = 'usdc', solUsd = null }) {
  const [hover, setHover] = useState(null)
  const [width, boxRef] = useWidth()
  const { W, H, PAD, PLOT, narrow } = geometry(width)

  /**
   * ⭐⭐ Every figure on this chart is a DOLLAR figure when a SOL price is available — the axis,
   * the headline, the hover and the table — because that is how pump.fun states a market cap and
   * this coin becomes one of theirs the moment the window closes. The arithmetic underneath stays
   * in SOL: converting once, at the edge where a number is drawn, keeps the curve exact and means
   * no two figures on the page can be converted at different rates.
   *
   * ⛔ Without a price it falls back to SOL, unit and all. A dollar sign over an assumed rate is
   * the one outcome worth avoiding.
   */
  const inUsd = typeof solUsd === 'number' && solUsd > 0
  const cap = (sol) => (inUsd ? fmtUsdCap(usdMarketCap(sol, solUsd)) : `${fmtSol(sol)} ${unitOf(curveQuote)}`)
  const payUnit = unitOf(payQuote)
  const quoteDecimals = payQuote === 'usdc' ? 1e6 : 1e9
  const openCap = openMarketCap(curveQuote)

  const series = useMemo(() => {
    if (!deposits?.length) return null
    const pts = deposits.map((d, i) => ({
      i,
      t: d.blockTime ?? null,
      mcap: marketCap(BigInt(d.priceAfter), curveQuote),
      amount: Number(d.amount) / quoteDecimals,
      allocation: Number(d.allocation) / 1e6,
      depositor: d.depositor,
    }))
    // The account read wins over the replayed stream for the final point. If the two disagree the
    // stream missed something, and the number a depositor is looking at must still be the true one.
    if (typeof nowMarketCap === 'number' && pts.length) {
      pts[pts.length - 1] = { ...pts[pts.length - 1], mcap: nowMarketCap }
    }
    return pts
  }, [deposits, nowMarketCap, curveQuote, quoteDecimals])

  if (!series) return null

  // Deposits inside one block share a timestamp. If they ALL do, a time axis has nothing to spread
  // the points across, so the x axis becomes the queue itself — which is what the price tracks.
  const times = series.map((p) => p.t).filter((t) => typeof t === 'number')
  const spanned = times.length === series.length && times[times.length - 1] > times[0]
  const span = spanned ? times[times.length - 1] - times[0] : 0
  const xOf = (p) => spanned
    ? PAD.left + ((p.t - times[0]) / (times[times.length - 1] - times[0])) * PLOT.w
    : PAD.left + (series.length === 1 ? PLOT.w / 2 : (p.i / (series.length - 1)) * PLOT.w)

  // Anchored at the open rather than the first deposit: the rise off the starting price is the
  // thing being shown, and a y axis starting at the first deposit hides it.
  const lo = Math.min(openCap, ...series.map((p) => p.mcap))
  const hiRaw = Math.max(openCap, ...series.map((p) => p.mcap))
  const hi = hiRaw + (hiRaw - lo) * 0.12 || hiRaw * 1.1
  const yOf = (v) => PAD.top + PLOT.h - ((v - lo) / (hi - lo || 1)) * PLOT.h

  // Price holds flat between deposits and jumps on each, so the line is stepped — a smooth
  // interpolation would draw prices that never existed.
  const first = series[0]
  let d = `M ${PAD.left} ${yOf(openCap)} L ${xOf(first)} ${yOf(openCap)} L ${xOf(first)} ${yOf(first.mcap)}`
  for (let i = 1; i < series.length; i++) {
    d += ` L ${xOf(series[i])} ${yOf(series[i - 1].mcap)} L ${xOf(series[i])} ${yOf(series[i].mcap)}`
  }
  const last = series[series.length - 1]
  d += ` L ${PAD.left + PLOT.w} ${yOf(last.mcap)}`
  const area = `${d} L ${PAD.left + PLOT.w} ${PAD.top + PLOT.h} L ${PAD.left} ${PAD.top + PLOT.h} Z`

  const multiple = last.mcap / openCap

  return (
    <div className="chart">
      <div className="chart-head">
        <div>
          <span className="chart-label">MC</span>
          <strong className="mono chart-now">{cap(last.mcap)}</strong>
          <span className="chart-mult mono">{multiple.toFixed(2)}× since the window opened</span>
        </div>
        <span className="chart-label">{series.length} buy{series.length === 1 ? '' : 's'}</span>
      </div>

      <div className="chart-plot" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img"
           aria-label={`${symbol || 'This coin'} market cap, ${cap(openCap)} at the open rising to ${cap(last.mcap)} over ${series.length} buys`}
           onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="pfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {ticks(lo, hi, narrow ? 3 : 4).map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + PLOT.w} y1={yOf(v)} y2={yOf(v)} className="chart-grid" />
            {/* The axis carries the same unit as the headline; a SOL tick under a dollar figure
                is how a reader ends up off by the SOL price. */}
            <text x={PAD.left - 9} y={yOf(v) + 4} className="chart-tick" textAnchor="end">{inUsd ? fmtUsdCap(usdMarketCap(v, solUsd)) : fmtSol(v)}</text>
          </g>
        ))}

        {/* The starting price, named. Without it the rise has no reference and the line is just a
            line going up. */}
        <line x1={PAD.left} x2={PAD.left + PLOT.w} y1={yOf(openCap)} y2={yOf(openCap)}
              className="chart-open" />

        <path d={area} fill="url(#pfFill)" />
        <path d={d} className="chart-line" />

        {series.map((p) => (
          <circle key={p.i} cx={xOf(p)} cy={yOf(p.mcap)} r={hover?.i === p.i ? 4.5 : 2.5} className="chart-dot" />
        ))}

        {hover && (
          <line x1={xOf(hover)} x2={xOf(hover)} y1={PAD.top} y2={PAD.top + PLOT.h} className="chart-cross" />
        )}

        {/* Hit targets, not the marks. A 2.5px dot is impossible to hover; these are full-height
            columns so the pointer only has to be near the right x. */}
        {series.map((p, i) => {
          const half = series.length === 1 ? PLOT.w / 2 : PLOT.w / (series.length - 1) / 2
          return (
            <rect key={`h${i}`} x={xOf(p) - half} y={PAD.top} width={half * 2} height={PLOT.h}
                  fill="transparent" onMouseEnter={() => setHover(p)} />
          )
        })}

        <text x={PAD.left} y={H - 8} className="chart-tick">
          {spanned ? fmtTime(times[0], span) : 'first buy'}
        </text>
        <text x={PAD.left + PLOT.w} y={H - 8} className="chart-tick" textAnchor="end">
          {spanned ? fmtTime(times[times.length - 1], span) : `buy ${series.length}`}
        </text>
      </svg>
      </div>

      {hover ? (
        <p className="chart-note mono">
          {hover.t ? fmtTime(hover.t, span) + ' · ' : ''}buy {hover.i + 1} of {series.length} ·{' '}
          {hover.amount.toFixed(3)} {payUnit} in · {hover.allocation.toLocaleString('en-US', { maximumFractionDigits: 0 })} {symbol || 'tokens'} out ·{' '}
          MC {cap(hover.mcap)}
        </p>
      ) : null}
    </div>
  )
}

/** Every point as a table. The chart is one reading of this; some people want the other. */
export function ChartTable({ deposits, symbol, curveQuote = 'sol', payQuote = 'usdc', solUsd = null }) {
  const unit = unitOf(curveQuote)
  // Same rule as the chart: dollars when a price is known, SOL with its unit when it is not.
  const inUsd = typeof solUsd === 'number' && solUsd > 0
  const payUnit = unitOf(payQuote)
  const quoteDecimals = payQuote === 'usdc' ? 1e6 : 1e9
  if (!deposits?.length) return null
  const ts = deposits.map((d) => d.blockTime).filter((t) => typeof t === 'number')
  const span = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0
  return (
    <details className="chart-table">
      <summary>Every buy, as a table</summary>
      <div className="chart-table-scroll">
        <table className="mono">
          <thead>
            <tr><th>#</th><th>Time</th><th>In ({payUnit})</th><th>Out ({symbol || 'tokens'})</th><th>Market cap{inUsd ? '' : ` (${unit})`}</th></tr>
          </thead>
          <tbody>
            {deposits.map((x, i) => (
              <tr key={x.signature}>
                <td>{i + 1}</td>
                <td>{x.blockTime ? fmtTime(x.blockTime, span) : '—'}</td>
                <td>{(Number(x.amount) / quoteDecimals).toFixed(3)}</td>
                <td>{(Number(x.allocation) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                <td>{inUsd ? fmtUsdCap(usdMarketCap(marketCap(BigInt(x.priceAfter), curveQuote), solUsd)) : fmtSol(marketCap(BigInt(x.priceAfter), curveQuote))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

/**
 * A row-sized version of the same line, for the listing.
 *
 * No axes, no labels, no hover: at 88×26 those would be noise, and the row already carries the
 * numbers. It answers one question — has this coin moved, and which way — which is exactly what a
 * sparkline is for. Same stepped geometry as the full chart, so the two cannot tell different
 * stories about the same sale.
 */
export function Sparkline({ spark, width = 64, height = 24, curveQuote = 'sol' }) {
  if (!spark?.length) return null
  // ⚠ The shape survives a wrong denomination — it is normalised to its own extremes — but the
  // MULTIPLE does not: a USDC curve measured against SOL's opening cap reads 0.02x at the open.
  const openCap = openMarketCap(curveQuote)
  const caps = [openCap, ...spark.map((v) => marketCap(BigInt(v), curveQuote))]
  const lo = Math.min(...caps), hi = Math.max(...caps)
  const x = (i) => (i / (caps.length - 1)) * (width - 2) + 1
  const y = (v) => height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)
  let d = `M ${x(0)} ${y(caps[0])}`
  for (let i = 1; i < caps.length; i++) d += ` L ${x(i)} ${y(caps[i - 1])} L ${x(i)} ${y(caps[i])}`
  const mult = caps[caps.length - 1] / openCap
  return (
    <span className="spark" title={`${mult.toFixed(2)}× since the window opened`}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
        <path d={d} className="spark-line" />
      </svg>
      <span className="spark-mult mono">{mult.toFixed(2)}×</span>
    </span>
  )
}
