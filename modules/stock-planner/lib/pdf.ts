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
  brand = 'WICKED · STOCK PLANNER',
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
      doc.setFontSize(8)
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

  // header band
  doc.setFillColor(...NAVY)
  doc.rect(0, 0, PAGE_W, 42, 'F')
  doc.setFillColor(...CYAN)
  doc.rect(0, 42, PAGE_W, 1.5, 'F')
  // Title — auto-shrink so a long name never runs off the header band.
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  fitFont(report.title, 20, 10, CONTENT_W)
  doc.text(report.title, MARGIN, 18)

  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...CYAN)
  const subLine = [report.ticker, report.company, report.asOf].filter(Boolean).join(' · ') || report.subtitle
  fitFont(subLine, 11, 8, CONTENT_W)
  doc.text(subLine, MARGIN, 27)

  if (report.subtitle) {
    doc.setTextColor(200, 205, 220)
    fitFont(report.subtitle, 9, 7, CONTENT_W)
    doc.text(report.subtitle, MARGIN, 35)
  }
  y = 52

  // stat cards (3 per row)
  if (report.stats.length > 0) {
    const cardW = (PAGE_W - MARGIN * 2 - 8) / 3
    const cardH = 16
    report.stats.slice(0, 12).forEach((s, i) => {
      const col = i % 3
      if (col === 0 && i > 0) y += cardH + 4
      ensure(cardH + 4)
      const x = MARGIN + col * (cardW + 4)
      doc.setFillColor(244, 246, 252)
      doc.setDrawColor(225, 229, 240)
      doc.roundedRect(x, y, cardW, cardH, 2, 2, 'FD')
      doc.setFontSize(7.5)
      doc.setTextColor(...MUTED)
      doc.text(s.label.toUpperCase().slice(0, 30), x + 3, y + 6)
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...INK)
      doc.text(s.value.slice(0, 24), x + 3, y + 12.5)
      doc.setFont('helvetica', 'normal')
    })
    y += 16 + 8
  }

  // sections
  for (const section of report.sections) {
    ensure(18)
    doc.setFillColor(...CYAN)
    doc.rect(MARGIN, y - 3.5, 1.6, 5, 'F')
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(...NAVY)
    doc.text(section.heading.slice(0, 70), MARGIN + 4, y)
    doc.setFont('helvetica', 'normal')
    y += 6
    if (section.body) {
      doc.setFontSize(9.5)
      doc.setTextColor(...INK)
      const lines = doc.splitTextToSize(section.body, PAGE_W - MARGIN * 2) as string[]
      for (const line of lines) {
        ensure(5)
        doc.text(line, MARGIN, y)
        y += 4.6
      }
    }
    for (const bullet of section.bullets) {
      doc.setFontSize(9.5)
      doc.setTextColor(...INK)
      const lines = doc.splitTextToSize(bullet, PAGE_W - MARGIN * 2 - 6) as string[]
      ensure(lines.length * 4.6 + 1)
      doc.setFillColor(...CYAN)
      doc.circle(MARGIN + 1.5, y - 1.2, 0.9, 'F')
      lines.forEach((line, i) => {
        doc.text(line, MARGIN + 5, y)
        y += 4.6
        if (i < lines.length - 1) ensure(5)
      })
    }
    y += 5
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
      const chartH = 72
      ensure(chartH + 20)
      // section heading
      doc.setFillColor(...CYAN)
      doc.rect(MARGIN, y - 3.5, 1.6, 5, 'F')
      doc.setFontSize(13)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...NAVY)
      doc.text('2-Year Price', MARGIN + 4, y)
      doc.setFont('helvetica', 'normal')
      y += 5

      const cx = MARGIN
      const cw = CONTENT_W
      const closes = bars.map((b) => b.c)
      const min = Math.min(...closes)
      const max = Math.max(...closes)
      const range = max - min || 1
      const px = (i: number): number => cx + (i / (bars.length - 1)) * cw
      const py = (c: number): number => y + chartH - ((c - min) / range) * chartH

      // frame
      doc.setDrawColor(225, 229, 240)
      doc.setFillColor(248, 250, 253)
      doc.roundedRect(cx, y, cw, chartH, 2, 2, 'FD')
      // price line
      doc.setDrawColor(...CYAN)
      doc.setLineWidth(0.4)
      let prevX = px(0)
      let prevY = py(closes[0])
      for (let i = 1; i < bars.length; i++) {
        const nx = px(i)
        const ny = py(closes[i])
        doc.line(prevX, prevY, nx, ny)
        prevX = nx
        prevY = ny
      }
      doc.setLineWidth(0.2)
      // last-price marker
      doc.setFillColor(...CYAN)
      doc.circle(px(bars.length - 1), py(closes[closes.length - 1]), 0.9, 'F')

      // axis labels
      doc.setFontSize(7)
      doc.setTextColor(...MUTED)
      doc.text(`$${max.toFixed(2)}`, cx + cw - 1, y + 3, { align: 'right' })
      doc.text(`$${min.toFixed(2)}`, cx + cw - 1, y + chartH - 1, { align: 'right' })
      const mLabel = (ms: number): string => {
        const d = new Date(ms)
        return `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
      }
      doc.text(mLabel(bars[0].t), cx + 1, y + chartH + 4)
      doc.setTextColor(...INK)
      doc.text(`Last $${closes[closes.length - 1].toFixed(2)}`, cx + cw / 2, y + chartH + 4, { align: 'center' })
      doc.setTextColor(...MUTED)
      doc.text(mLabel(bars[bars.length - 1].t), cx + cw - 1, y + chartH + 4, { align: 'right' })
      y += chartH + 10
    }
  }

  // disclaimer
  if (report.disclaimer) {
    ensure(16)
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    const lines = doc.splitTextToSize(report.disclaimer, PAGE_W - MARGIN * 2) as string[]
    for (const line of lines) {
      ensure(4)
      doc.text(line, MARGIN, y)
      y += 3.6
    }
  }

  footer()
  return doc.output('datauristring').split(',')[1] ?? ''
}
