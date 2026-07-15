import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'fs'
import { marked } from 'marked'

const PDF_CSS = `
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a202c; max-width: 760px; margin: 0 auto; line-height: 1.55; font-size: 13px; }
  h1 { font-size: 24px; border-bottom: 2px solid #38bdf8; padding-bottom: 8px; }
  h2 { font-size: 17px; margin-top: 26px; color: #0c4a6e; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; font-family: Consolas, monospace; font-size: 12px; }
  pre { background: #f1f5f9; padding: 12px; border-radius: 8px; overflow-x: hidden; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  ul, ol { padding-left: 22px; }
  blockquote { border-left: 3px solid #cbd5e1; margin-left: 0; padding-left: 14px; color: #475569; }
`

export async function exportReport(
  markdown: string,
  format: 'md' | 'pdf',
  parent: BrowserWindow | null
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: `Export project report (${format.toUpperCase()})`,
    defaultPath: `codelens-report.${format}`,
    filters:
      format === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'PDF', extensions: ['pdf'] }]
  }
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return null

  if (format === 'md') {
    await fs.writeFile(filePath, markdown, 'utf8')
    return filePath
  }

  // PDF: render the markdown in a hidden window and print it.
  const body = (marked.parse(markdown, { async: false }) as string)
    // strip scripts defensively — the markdown comes back from an LLM
    .replace(/<script[\s\S]*?<\/script>/gi, '')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body>${body}</body></html>`

  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false }
  })
  try {
    await pdfWin.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`
    )
    const pdf = await pdfWin.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
    })
    await fs.writeFile(filePath, pdf)
    return filePath
  } finally {
    pdfWin.destroy()
  }
}
