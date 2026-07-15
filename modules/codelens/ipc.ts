// CodeLens module — main-process IPC. Ported from the standalone app's
// src/main/ipc.ts; registration goes through the WICKED module contract
// (default-export register(ctx)) and every channel is renamed to codelens:*.
import { promises as fs } from 'fs'
import * as path from 'path'
import type { ModuleIpcContext } from '../../src/main/module-ipc'
import { CHANNELS } from './shared/api'
import { AI_PROVIDER_IDS } from './shared/providers'
import type { AiProvider, IpcResult, ScanResult, Settings, TreeNode } from './shared/types'
import {
  activeAiLabel,
  aiAvailable,
  configureAi,
  explainConnections,
  explainFile,
  explainIssue,
  friendlyAiError,
  NO_KEY_MESSAGE,
  summarizeProject,
  testApiKey
} from './ipc/ai'
import type { SummaryContext } from './ipc/ai'
import { buildGraph } from './ipc/depgraph'
import { exportReport } from './ipc/report'
import { annotateTree, scanProject } from './ipc/scanner'
import * as store from './ipc/store'
import { scanVulnerabilities } from './ipc/vulnscan'

const MAX_PREVIEW_CHARS = 120_000
const MAX_KEY_FILES = 12

let currentScan: ScanResult | null = null

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}
function fail<T>(error: unknown): IpcResult<T> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}
function aiFail<T>(error: unknown): IpcResult<T> {
  return { ok: false, error: friendlyAiError(error) }
}

/** CodeLens provider ids → WICKED central-vault provider ids. */
const VAULT_ID: Record<AiProvider, string> = {
  claude: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  deepseek: 'deepseek'
}

function keyFlags(ctx: ModuleIpcContext): Record<AiProvider, boolean> {
  return Object.fromEntries(
    AI_PROVIDER_IDS.map((p) => [p, Boolean(ctx.getApiKey(VAULT_ID[p]))])
  ) as Record<AiProvider, boolean>
}

/**
 * (Re)build the AI client from module config + the central key vault. Called
 * before every AI request so key changes in Settings → API Keys apply
 * immediately, without a module-level key cache.
 */
function applyAiConfig(ctx: ModuleIpcContext): void {
  const provider = store.getAiProvider()
  configureAi(provider, store.getAiModel(provider), ctx.getApiKey(VAULT_ID[provider]))
}

function settings(ctx: ModuleIpcContext): Settings {
  const provider = store.getAiProvider()
  const models = Object.fromEntries(
    AI_PROVIDER_IDS.map((p) => [p, store.getAiModel(p)])
  ) as Record<AiProvider, string>
  return {
    ai: { provider, model: models[provider], models, hasKey: keyFlags(ctx) },
    recentProjects: store.getRecentProjects(),
    customIgnores: store.getCustomIgnores()
  }
}

function assertProvider(provider: unknown): AiProvider {
  if (!AI_PROVIDER_IDS.includes(provider as AiProvider)) {
    throw new Error(`Unknown AI provider: ${String(provider)}`)
  }
  return provider as AiProvider
}

/** Resolve a project-relative path, refusing anything that escapes the root. */
function safeAbs(rel: string): string {
  if (!currentScan) throw new Error('No project loaded')
  const root = path.resolve(currentScan.rootPath)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path is outside the project folder')
  }
  return abs
}

async function readProjectFile(rel: string): Promise<string> {
  return fs.readFile(safeAbs(rel), 'utf8')
}

function requireFile(rel: string) {
  const file = currentScan?.files.find((f) => f.relPath === rel)
  if (!currentScan || !file) throw new Error('File not found in the current scan')
  return file
}

function treeToText(tree: TreeNode, maxLines: number): string {
  const lines: string[] = []
  function visit(node: TreeNode, depth: number): void {
    if (lines.length >= maxLines) return
    if (node.relPath !== '') {
      lines.push(`${'  '.repeat(depth)}${node.name}${node.type === 'dir' ? '/' : ''}`)
    }
    for (const child of node.children ?? []) visit(child, node.relPath === '' ? 0 : depth + 1)
  }
  visit(tree, 0)
  if (lines.length >= maxLines) lines.push('… (tree truncated)')
  return lines.join('\n')
}

async function buildSummaryContext(scan: ScanResult): Promise<SummaryContext> {
  const degree = new Map<string, number>()
  for (const e of scan.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }

  const picks: string[] = []
  const push = (rel: string | undefined): void => {
    if (rel && !picks.includes(rel) && scan.files.some((f) => f.relPath === rel)) picks.push(rel)
  }

  push(scan.files.find((f) => /^readme\.md$/i.test(f.relPath))?.relPath)
  push(scan.files.find((f) => f.relPath === 'package.json')?.relPath)
  push(scan.files.find((f) => f.relPath === 'go.mod')?.relPath)
  push(
    scan.files.find((f) => f.relPath === 'pyproject.toml' || f.relPath === 'requirements.txt')
      ?.relPath
  )

  // Entry-point-looking files near the root.
  for (const f of scan.files) {
    const depth = f.relPath.split('/').length
    if (depth <= 3 && /^(index|main|app|server|cli|program|__main__)\.[a-z]+$/i.test(f.name)) {
      push(f.relPath)
    }
  }

  // Most-connected files.
  const ranked = [...degree.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel)
  for (const rel of ranked) {
    if (picks.length >= MAX_KEY_FILES) break
    push(rel)
  }

  const keyFiles: SummaryContext['keyFiles'] = []
  for (const rel of picks.slice(0, MAX_KEY_FILES)) {
    try {
      keyFiles.push({ relPath: rel, content: await readProjectFile(rel) })
    } catch {
      // unreadable — skip
    }
  }

  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 }
  for (const i of scan.issues) sevCounts[i.severity]++
  const topIssues = scan.issues
    .slice()
    .sort((a, b) => b.severity.localeCompare(a.severity))
    .slice(0, 8)
    .map((i) => `- [${i.severity}] ${i.title} — ${i.file}:${i.line}`)
    .join('\n')

  return {
    projectName: scan.projectName,
    stats: `${scan.fileCount} files, ${scan.edges.length} internal dependencies, ${scan.issues.length} static-analysis findings.`,
    treeText: treeToText(scan.tree, 250),
    hotspots:
      ranked
        .slice(0, 10)
        .map((rel) => `- ${rel} (${degree.get(rel)} connections)`)
        .join('\n') || '- (no internal dependencies detected)',
    issuesText:
      scan.issues.length === 0
        ? 'No issues flagged.'
        : `${sevCounts.critical} critical, ${sevCounts.high} high, ${sevCounts.medium} medium, ${sevCounts.low} low.\nTop findings:\n${topIssues}`,
    keyFiles
  }
}

export default function register(ctx: ModuleIpcContext): void {
  const { ipcMain, dialog, getMainWindow } = ctx

  // Keys live in the WICKED central vault (Settings → API Keys); build the AI
  // client from module provider/model config + vault key.
  try {
    applyAiConfig(ctx)
  } catch (err) {
    console.error('[codelens] failed to apply AI config', err)
  }

  ipcMain.handle(CHANNELS.selectFolder, async () => {
    const win = getMainWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Open a project folder',
      properties: ['openDirectory']
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return canceled || filePaths.length === 0 ? null : filePaths[0]
  })

  ipcMain.handle(
    CHANNELS.scanProject,
    async (_e, rootPath: string): Promise<IpcResult<ScanResult>> => {
      try {
        const started = Date.now()
        const project = await scanProject(rootPath, store.getCustomIgnores())
        const edges = buildGraph(project)
        const issues = scanVulnerabilities(project)
        annotateTree(project.tree, issues)
        const result: ScanResult = {
          rootPath: project.rootPath,
          projectName: path.basename(project.rootPath) || project.rootPath,
          scannedAt: started,
          durationMs: Date.now() - started,
          fileCount: project.files.length,
          dirCount: project.dirCount,
          skippedCount: project.skippedCount,
          truncated: project.truncated,
          tree: project.tree,
          files: project.files,
          edges,
          issues
        }
        project.contents.clear() // free memory; AI calls re-read from disk
        currentScan = result
        store.addRecentProject(rootPath)
        return ok(result)
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(
    CHANNELS.readFile,
    async (_e, rel: string): Promise<IpcResult<{ content: string; truncated: boolean }>> => {
      try {
        requireFile(rel)
        const content = await readProjectFile(rel)
        return ok({
          content: content.slice(0, MAX_PREVIEW_CHARS),
          truncated: content.length > MAX_PREVIEW_CHARS
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  ipcMain.handle(CHANNELS.getSettings, () => settings(ctx))

  ipcMain.handle(CHANNELS.setCustomIgnores, (_e, ignores: string[]) => {
    store.setCustomIgnores(Array.isArray(ignores) ? ignores : [])
    return settings(ctx)
  })

  ipcMain.handle(CHANNELS.setAiConfig, (_e, provider: unknown, model: string) => {
    const p = assertProvider(provider)
    store.setAiProvider(p)
    store.setAiModel(p, String(model ?? ''))
    applyAiConfig(ctx)
    return settings(ctx)
  })

  ipcMain.handle(CHANNELS.testApiKey, async (): Promise<IpcResult<string>> => {
    applyAiConfig(ctx)
    if (!aiAvailable()) return fail(new Error(NO_KEY_MESSAGE))
    try {
      await testApiKey()
      return ok(`Key verified — ${activeAiLabel()} responded.`)
    } catch (err) {
      return aiFail(err)
    }
  })

  ipcMain.handle(CHANNELS.explainFile, async (_e, rel: string) => {
    try {
      const file = requireFile(rel)
      applyAiConfig(ctx)
      if (!aiAvailable()) return fail(new Error(NO_KEY_MESSAGE))
      const content = await readProjectFile(rel)
      return ok(await explainFile(file, content))
    } catch (err) {
      return aiFail(err)
    }
  })

  ipcMain.handle(CHANNELS.explainConnections, async (_e, rel: string) => {
    try {
      const file = requireFile(rel)
      applyAiConfig(ctx)
      if (!aiAvailable()) return fail(new Error(NO_KEY_MESSAGE))
      const inbound = currentScan!.edges.filter((e) => e.target === rel).map((e) => e.source)
      const outbound = currentScan!.edges.filter((e) => e.source === rel).map((e) => e.target)
      return ok(await explainConnections(file, inbound, outbound))
    } catch (err) {
      return aiFail(err)
    }
  })

  ipcMain.handle(CHANNELS.explainIssue, async (_e, issueId: string) => {
    try {
      if (!currentScan) throw new Error('No project loaded')
      const issue = currentScan.issues.find((i) => i.id === issueId)
      if (!issue) throw new Error('Issue not found in the current scan')
      applyAiConfig(ctx)
      if (!aiAvailable()) return fail(new Error(NO_KEY_MESSAGE))
      let content: string | null = null
      try {
        content = await readProjectFile(issue.file)
      } catch {
        content = null
      }
      return ok(await explainIssue(issue, content))
    } catch (err) {
      return aiFail(err)
    }
  })

  ipcMain.handle(CHANNELS.summarizeProject, async () => {
    try {
      if (!currentScan) throw new Error('No project loaded')
      applyAiConfig(ctx)
      if (!aiAvailable()) return fail(new Error(NO_KEY_MESSAGE))
      const summaryCtx = await buildSummaryContext(currentScan)
      return ok(await summarizeProject(summaryCtx))
    } catch (err) {
      return aiFail(err)
    }
  })

  ipcMain.handle(CHANNELS.exportReport, async (_e, markdown: string, format: 'md' | 'pdf') => {
    try {
      if (format !== 'md' && format !== 'pdf') throw new Error('Unknown export format')
      const saved = await exportReport(String(markdown ?? ''), format, getMainWindow())
      return ok(saved)
    } catch (err) {
      return fail(err)
    }
  })
}
