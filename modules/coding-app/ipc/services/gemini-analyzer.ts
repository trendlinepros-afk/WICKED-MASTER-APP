import { GoogleGenerativeAI } from '@google/generative-ai'
import { configStore } from './config-persistence'
import { fileManager } from './file-manager'
import { ollamaService } from './ollama'
import { apiProviderService } from './api-providers'
import { parseModelId } from './models'
import { getApiKey } from './keys'
import { logger } from './logger'
import type { GeminiAnalysisData, FileChange } from '../../shared/types'
import type { ProviderId } from '../../shared/config'

const ANALYSIS_PROMPT = `This screenshot is a live preview of an app/website we are currently building.
Please analyze it and identify any bugs, UI issues, layout problems, missing elements, or improvements needed.`

const GEMINI_MODEL = 'gemini-2.5-pro' // fixed per spec, not user-selectable

/**
 * Sends a preview screenshot to Gemini 2.5 Pro for visual QA and, when asked,
 * drives an automated fix by feeding Gemini's findings plus the current project
 * files to the active coding model and writing the returned file blocks to disk.
 */
export class GeminiAnalyzer {
  private hasKey(): boolean {
    return !!getApiKey('gemini')
  }

  async analyze(
    screenshotBase64: string
  ): Promise<GeminiAnalysisData | { error: string }> {
    if (!this.hasKey()) {
      return { error: 'Gemini API key is not configured (WICKED Settings → API Keys).' }
    }
    try {
      const genai = new GoogleGenerativeAI(getApiKey('gemini'))
      const model = genai.getGenerativeModel({ model: GEMINI_MODEL })
      const result = await model.generateContent([
        { text: ANALYSIS_PROMPT },
        { inlineData: { mimeType: 'image/png', data: screenshotBase64 } }
      ])
      const analysis = result.response.text()
      return {
        screenshotBase64,
        analysis,
        issueCount: countIssues(analysis),
        actionTaken: null,
        changes: []
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Gemini analysis failed', message)
      return { error: `Gemini analysis failed: ${message}` }
    }
  }

  /**
   * Attempt to fix the issues Gemini reported. Uses the last-selected coding
   * model to generate corrected files, then applies the file blocks to the
   * active project. Returns the changes applied.
   */
  async applyFix(
    analysis: GeminiAnalysisData
  ): Promise<{ ok: boolean; changes: FileChange[]; error?: string }> {
    const cfg = configStore.load()
    const modelId = cfg.lastSelectedModel
    if (!modelId) {
      return { ok: false, changes: [], error: 'No coding model selected.' }
    }
    const root = fileManager.getActiveRoot()
    if (!root) {
      return { ok: false, changes: [], error: 'No active project to fix.' }
    }

    const context = buildProjectContext()
    const fixPrompt = `A visual QA tool analyzed a live preview of the project and reported the following issues:

${analysis.analysis}

Here are the current project files:

${context}

Fix the reported issues. Respond ONLY with the complete updated files, each in a fenced code block whose info string names the file path, e.g.:

\`\`\`tsx title="src/App.tsx"
...full file contents...
\`\`\`

Only include files you are changing.`

    try {
      const { provider, model } = parseModelId(modelId)
      const messages = [{ role: 'user' as const, content: fixPrompt }]
      const controller = new AbortController()
      let full = ''
      const onToken = (t: string): void => {
        full += t
      }
      if (provider === 'ollama') {
        full = await ollamaService.streamChat(
          model,
          messages,
          { temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal: controller.signal },
          onToken
        )
      } else {
        full = await apiProviderService.streamChat(
          provider as ProviderId,
          model,
          messages,
          { temperature: cfg.temperature, maxTokens: cfg.maxTokens, signal: controller.signal },
          onToken
        )
      }
      const changes = fileManager.applyFileBlocks(full)
      return { ok: true, changes }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('Auto-fix failed', message)
      return { ok: false, changes: [], error: message }
    }
  }
}

/** Heuristic issue count: number of bullet/numbered items in the response. */
function countIssues(text: string): number {
  const bullets = text.match(/^\s*(?:[-*]|\d+\.)\s+/gm)
  if (bullets && bullets.length > 0) return bullets.length
  // Fallback: sentences mentioning issue-like keywords.
  const matches = text.match(/\b(bug|issue|problem|error|missing|misaligned|overflow)\b/gi)
  return matches ? Math.min(matches.length, 10) : 0
}

/** Concatenate a bounded snapshot of the project's text files for the fix prompt. */
function buildProjectContext(): string {
  const tree = fileManager.getFileTree()
  const paths: string[] = []
  const walk = (nodes: ReturnType<typeof fileManager.getFileTree>): void => {
    for (const n of nodes) {
      if (n.isDirectory) walk(n.children ?? [])
      else if (isTextFile(n.path)) paths.push(n.path)
    }
  }
  walk(tree)
  const chunks: string[] = []
  let budget = 24000 // ~ characters, keep the prompt bounded
  for (const p of paths.slice(0, 40)) {
    try {
      const content = fileManager.readFile(p)
      const block = `\`\`\` title="${p}"\n${content}\n\`\`\``
      if (budget - block.length < 0) break
      budget -= block.length
      chunks.push(block)
    } catch {
      // skip unreadable
    }
  }
  return chunks.join('\n\n')
}

function isTextFile(path: string): boolean {
  return /\.(tsx?|jsx?|css|scss|html?|json|md|py|java|vue|svelte)$/i.test(path)
}

export const geminiAnalyzer = new GeminiAnalyzer()
