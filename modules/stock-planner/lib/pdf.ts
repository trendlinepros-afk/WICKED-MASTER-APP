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

export function buildReportPdf(report: ReportSpec, images: string[], brand = 'WICKED · STOCK PLANNER'): string {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  let y = 0

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
  doc.setTextColor(255, 255, 255)
  doc.setFontSize(20)
  doc.setFont('helvetica', 'bold')
  doc.text(report.title.slice(0, 60), MARGIN, 18)
  doc.setFontSize(11)
  doc.setFont('helvetica', 'normal')
  doc.setTextColor(...CYAN)
  doc.text(
    [report.ticker, report.company, report.asOf].filter(Boolean).join(' · ').slice(0, 90) || report.subtitle.slice(0, 90),
    MARGIN,
    27
  )
  if (report.subtitle) {
    doc.setTextColor(200, 205, 220)
    doc.setFontSize(9)
    doc.text(report.subtitle.slice(0, 110), MARGIN, 35)
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

  // screenshots
  for (const img of images.slice(0, 4)) {
    try {
      const w = PAGE_W - MARGIN * 2
      const h = w * 0.56
      ensure(h + 8)
      doc.addImage(img, img.includes('image/png') ? 'PNG' : 'JPEG', MARGIN, y, w, h, undefined, 'FAST')
      y += h + 6
    } catch {
      /* skip an unreadable image rather than fail the export */
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
