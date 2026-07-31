import { jsPDF } from 'jspdf'
import type { ReportSpec } from '../ipc/report'

/**
 * Styled report PDF (client-side jsPDF, ported brand): navy/cyan, stat cards,
 * sections, embedded screenshots, page footers. Returns base64 (no prefix).
 */

const NAVY: [number, number, number] = [11, 16, 34] // #0b1022
const CYAN: [number, number, number] = [33, 212, 253] // #21d4fd
const INK: [number, number, number] = [30, 34, 48]
const MUTED: [number, number, number] = [110, 118, 138]

const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 16

export function buildReportPdf(
  report: ReportSpec,
  images: string[],
  brand = 'WICKED · STOCK RESEARCH',
  chartBars: { t: number; c: number }[] = []
): string {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  let y = 0

  /** Shrink a line of text until it fits `maxW`, set that size, and return it. */
  const fitFont = (text: string, startSize: number, minSize: number, maxW: number): void => {
    let size = startSize
    doc.setFontSize(size)
    while (size > minSize && doc.getTextWidth(text) > maxW) {
      size -= 0.5
      doc.setFontSize(size)
    }
  }
  const CONTENT_W = PAGE_W - MARGIN * 2

  const footer = (): void => {
    const pages = doc.getNumberOfPages()
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i)
      doc.setFontSize(9.5)
      doc.setTextColor(...MUTED)
      doc.text(brand, MARGIN, PAGE_H - 8)
      doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 8, { align: 'right' })
    }
  }

  const ensure = (needed: number): void => {
    if (y + needed > PAGE_H - 16) {
      doc.addPage()
      y = MARGIN
    }
  }

  // header band — print-friendly: white background (saves ink), dark text, a thin
  // cyan accent rule under it for brand identity.
  const SUBCLR: [number, number, number] = [14, 116, 144] // cyan-700, readable on white
  doc.setFillColor(...CYAN)
  doc.rect(0, 42, PAGE_W, 1.2, 'F')
  // Title — auto-shrink so a long name never runs off the header band.
  doc.setTextColor(...NAVY)
  doc.setFont('helvetica', 'bold')
  fitFont(report.title, 22, 12, CONTENT_W)
  doc.text(report.title, MARGIN, 18)

  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...SUBCLR)
  const subLine = [report.ticker, report.company, report.asOf].filter(Boolean).join(' · ') || report.subtitle
  fitFont(subLine, 12.5, 9, CONTENT_W)
  doc.text(subLine, MARGIN, 27)

  if (report.subtitle) {
    doc.setTextColor(...MUTED)
    fitFont(report.subtitle, 10.5, 8, CONTENT_W)
    doc.text(report.subtitle, MARGIN, 35)
  }
  y = 52

  // stat cards (3 per row)
  if (report.stats.length > 0) {
    const cardW = (PAGE_W - MARGIN * 2 - 8) / 3
    const cardH = 18
    report.stats.slice(0, 12).forEach((s, i) => {
      const col = i % 3
      if (col === 0 && i > 0) y += cardH + 4
      ensure(cardH + 4)
      const x = MARGIN + col * (cardW + 4)
      const innerW = cardW - 6
      doc.setFillColor(244, 246, 252)
      doc.setDrawColor(225, 229, 240)
      doc.roundedRect(x, y, cardW, cardH, 2, 2, 'FD')
      // label — shrink to fit the card width so it never clips
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...MUTED)
      fitFont(s.label.toUpperCase(), 9, 6.5, innerW)
      doc.text(s.label.toUpperCase(), x + 3, y + 6.5)
      // value — one line at 13pt if it fits, else WRAP to ≤2 lines, shrinking the
      // font until it fits (so a long sector name wraps instead of clipping).
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...INK)
      doc.setFontSize(13)
      if (doc.getTextWidth(s.value) <= innerW) {
        doc.text(s.value, x + 3, y + 14)
      } else {
        let vs = 10.5
        let lines = doc.splitTextToSize(s.value, innerW) as string[]
        while (lines.length > 2 && vs > 7) {
          vs -= 0.5
          doc.setFontSize(vs)
          lines = doc.splitTextToSize(s.value, innerW) as string[]
        }
        doc.text(lines.slice(0, 2), x + 3, y + 11.5, { lineHeightFactor: 1.15 })
      }
      doc.setFont('helvetica', 'normal')
    })
    y += cardH + 8
  }

  // sections
  for (const section of report.sections) {
    ensure(18)
    doc.setFillColor(...CYAN)
    doc.rect(MARGIN, y - 3.5, 1.6, 5, 'F')
    doc.setFontSize(15)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...NAVY)
    doc.text(section.heading.slice(0, 70), MARGIN + 4, y)
    doc.setFont('helvetica', 'normal')
    y += 7
    if (section.body) {
      doc.setFontSize(11.5)
      doc.setTextColor(...INK)
      const lines = doc.splitTextToSize(section.body, PAGE_W - MARGIN * 2) as string[]
      for (const line of lines) {
        ensure(6)
        doc.text(line, MARGIN, y)
        y += 5.4
      }
    }
    for (const bullet of section.bullets) {
      doc.setFontSize(11.5)
      doc.setTextColor(...INK)
      const lines = doc.splitTextToSize(bullet, PAGE_W - MARGIN * 2 - 6) as string[]
      ensure(lines.length * 5.4 + 1)
      doc.setFillColor(...CYAN)
      doc.circle(MARGIN + 1.7, y - 1.3, 1, 'F')
      lines.forEach((line, i) => {
        doc.text(line, MARGIN + 5, y)
        y += 5.4
        if (i < lines.length - 1) ensure(6)
      })
    }
    y += 6
  }

  // Chart: the user's trendline screenshots when provided, otherwise a generated
  // 2-year price line so every report has a chart.
  if (images.length > 0) {
    for (const img of images.slice(0, 4)) {
      try {
        const w = CONTENT_W
        const h = w * 0.56
        ensure(h + 8)
        doc.addImage(img, img.includes('image/png') ? 'PNG' : 'JPEG', MARGIN, y, w, h, undefined, 'FAST')
        y += h + 6
      } catch {
        /* skip an unreadable image rather than fail the export */
      }
    }
  } else {
    const bars = chartBars.filter((b) => Number.isFinite(b.t) && Number.isFinite(b.c) && b.c > 0)
    if (bars.length > 1) {
      const chartH = 70
      ensure(chartH + 22)
      const n = bars.length
      const closes = bars.map((b) => b.c)
      const min = Math.min(...closes)
      const max = Math.max(...closes)
      const range = max - min || 1
      const last = closes[n - 1]
      const first = closes[0]
      const chg = first > 0 ? ((last - first) / first) * 100 : 0

      // heading + last price / 2-year change
      doc.setFillColor(...CYAN)
      doc.rect(MARGIN, y - 3.5, 1.6, 5, 'F')
      doc.setFontSize(15)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...NAVY)
      doc.text('2-Year Price', MARGIN + 4, y)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9.5)
      doc.setTextColor(...MUTED)
      doc.text(`Last $${last.toFixed(2)} · ${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% / 2y`, MARGIN + CONTENT_W, y, { align: 'right' })
      y += 6

      const cx = MARGIN
      const axisW = 15 // right gutter reserved for the price scale
      const plotW = CONTENT_W - axisW
      const px = (i: number): number => cx + (i / (n - 1)) * plotW
      const py = (c: number): number => y + chartH - ((c - min) / range) * chartH

      // plot frame
      doc.setDrawColor(225, 229, 240)
      doc.setFillColor(248, 250, 253)
      doc.roundedRect(cx, y, plotW, chartH, 1.5, 1.5, 'FD')

      // price scale (right) with horizontal gridlines
      const PT = 4
      doc.setFontSize(7.5)
      doc.setLineWidth(0.15)
      for (let i = 0; i <= PT; i++) {
        const price = min + (range * i) / PT
        const gy = py(price)
        if (i > 0 && i < PT) {
          doc.setDrawColor(232, 235, 244)
          doc.line(cx, gy, cx + plotW, gy)
        }
        doc.setTextColor(...MUTED)
        doc.text(`$${price.toFixed(2)}`, cx + plotW + 1.5, gy + 1)
      }

      // date axis (bottom) with vertical gridlines
      const DT = 5
      const mLabel = (ms: number): string => {
        const d = new Date(ms)
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`
      }
      doc.setFontSize(7)
      for (let i = 0; i <= DT; i++) {
        const idx = Math.round(((n - 1) * i) / DT)
        const gx = px(idx)
        if (i > 0 && i < DT) {
          doc.setDrawColor(232, 235, 244)
          doc.line(gx, y, gx, y + chartH)
        }
        doc.setTextColor(...MUTED)
        const align: 'left' | 'center' | 'right' = i === 0 ? 'left' : i === DT ? 'right' : 'center'
        doc.text(mLabel(bars[idx].t), gx, y + chartH + 3.5, { align })
      }

      // price line
      doc.setDrawColor(...CYAN)
      doc.setLineWidth(0.4)
      let prevX = px(0)
      let prevY = py(closes[0])
      for (let i = 1; i < n; i++) {
        const nx = px(i)
        const ny = py(closes[i])
        doc.line(prevX, prevY, nx, ny)
        prevX = nx
        prevY = ny
      }
      // last-price marker
      doc.setLineWidth(0.2)
      doc.setFillColor(...CYAN)
      doc.circle(px(n - 1), py(last), 0.9, 'F')

      y += chartH + 9
    }
  }

  // disclaimer
  if (report.disclaimer) {
    ensure(16)
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    const lines = doc.splitTextToSize(report.disclaimer, PAGE_W - MARGIN * 2) as string[]
    for (const line of lines) {
      ensure(5)
      doc.text(line, MARGIN, y)
      y += 4.3
    }
  }

  footer()
  return doc.output('datauristring').split(',')[1] ?? ''
}
