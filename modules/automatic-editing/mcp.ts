import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'
import { CH, MODULE_ID } from './shared/channels'
import type { StageId } from './shared/types'

/**
 * MCP tools for Automatic Editing. Every tool delegates to the SAME
 * main-process channel the module UI calls (see ipc.ts + shared/channels.ts) —
 * no editing/render/upload logic is duplicated here.
 *
 * Gate policy on the MCP path:
 *  - Destructive tools (delete a project, re-render a stage, render/export the
 *    final, approve+composite graphics, upload+submit shorts) set
 *    `destructive: true` and route through ctx.confirm with an exact summary.
 *  - Credential tools NEVER auto-use the shell vault here. They gate on
 *    ctx.credential('<specific name>', args.credential) so the caller must
 *    explicitly authorise the metered/paid call. Different actions name
 *    different credentials (Whisper vs the routed AI provider vs OpusClip/S3).
 *
 * This file imports ONLY the pure channel-name/type maps — never ipc.ts, which
 * registers the privileged `wcmedia` scheme at import time.
 */

/**
 * Per-stage credential the MCP caller must authorise before a stage runs.
 * Stages that are pure local ffmpeg work (transitions / audio / preview) need
 * no credential. cut-detect transcribes (OpenAI Whisper); cut-review and
 * graphics call the routed AI provider (Gemini / OpenAI / DeepSeek / Anthropic).
 */
const STAGE_CREDENTIAL: Partial<Record<StageId, string>> = {
  'cut-detect': 'OpenAI API key (Whisper transcription)',
  'cut-review':
    'AI provider API key (cut review — routed to Gemini/OpenAI/DeepSeek/Anthropic per your AI settings)',
  graphics:
    'AI provider API key (graphics planning — routed to Gemini/OpenAI/DeepSeek/Anthropic per your AI settings)'
}

const stageArg = z
  .enum(['cut-detect', 'cut-review', 'transitions', 'graphics', 'audio', 'preview'])
  .describe('Pipeline stage to (re-)run. Runs this stage plus every downstream stage.')

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    // -- Projects ------------------------------------------------------------
    {
      name: `${MODULE_ID}__list-projects`,
      description: 'List all Automatic Editing projects (id, name, source, duration, approved). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(CH.projectList)
    },
    {
      name: `${MODULE_ID}__project-open`,
      description:
        'Open one project by id and return its full state: media pool, transcript, EDL, per-stage status, graphics, shorts. Read-only.',
      inputSchema: {
        id: z.string().describe('Project id (from list-projects).')
      },
      handler: (args) => ctx.invoke(CH.projectOpen, String(args.id ?? ''))
    },
    {
      name: `${MODULE_ID}__project-create`,
      description:
        'Create a new project. Optionally attach a source video by absolute path (else attach media later with media-import).',
      inputSchema: {
        name: z.string().describe('Project name.'),
        sourcePath: z.string().optional().describe('Absolute path to a source video to attach now (optional).')
      },
      handler: (args) => {
        const sourcePath = args.sourcePath === undefined ? undefined : String(args.sourcePath)
        return ctx.invoke(CH.projectCreate, String(args.name ?? ''), sourcePath)
      }
    },
    {
      name: `${MODULE_ID}__project-delete`,
      description:
        'Permanently delete a project and its work directory (all intermediate, preview and final renders). Destructive — cannot be undone.',
      destructive: true,
      inputSchema: {
        id: z.string().describe('Project id to delete.'),
        confirm: z.boolean().optional().describe('Set true to actually delete (see confirmation).')
      },
      handler: (args) => {
        const id = String(args.id ?? '')
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Permanently delete project "${id}", including its work directory and every intermediate, preview and final render. This cannot be undone.`
        )
        if (gate) return gate
        return ctx.invoke(CH.projectDelete, id)
      }
    },

    // -- Media pool ----------------------------------------------------------
    {
      name: `${MODULE_ID}__media-import`,
      description:
        'Import one or more videos into a project media pool by absolute path. Files are referenced in place (never copied or moved). The current pool is returned by project-open/list-projects — there is no separate list channel.',
      inputSchema: {
        projectId: z.string().describe('Target project id.'),
        paths: z.array(z.string()).describe('Absolute paths of video files (or folders) to add.')
      },
      handler: (args) =>
        ctx.invoke(CH.mediaImport, String(args.projectId ?? ''), (args.paths as string[] | undefined) ?? [])
    },

    // -- Pipeline ------------------------------------------------------------
    {
      name: `${MODULE_ID}__transcript-estimate`,
      description:
        'Estimate Whisper transcription cost for a project (minutes + estimated USD). Pure local calculation — no API call, no credential. Read-only.',
      inputSchema: {
        projectId: z.string().describe('Project id.')
      },
      handler: (args) => ctx.invoke(CH.transcriptEstimate, String(args.projectId ?? ''))
    },
    {
      name: `${MODULE_ID}__pipeline-run-stage`,
      description:
        'Run one pipeline stage (and every downstream stage) for a project. Destructive: re-renders and overwrites this stage plus all downstream intermediate artifacts (and, for cut-review, re-applies cuts to the trimmed video). Credential depends on the stage: cut-detect needs the OpenAI Whisper key; cut-review and graphics need the routed AI-provider key; transitions/audio/preview need none. The graphics stage re-plans and pauses at the approval gate (see approve-graphics).',
      destructive: true,
      inputSchema: {
        projectId: z.string().describe('Project id.'),
        stage: stageArg,
        region: z
          .object({ start: z.number(), end: z.number() })
          .optional()
          .describe('Optional time region (source seconds) to scope the re-run.'),
        credential: z
          .string()
          .optional()
          .describe('Required for cut-detect (Whisper) and cut-review/graphics (AI provider) stages.'),
        confirm: z.boolean().optional().describe('Set true to actually run (see confirmation).')
      },
      handler: (args) => {
        const projectId = String(args.projectId ?? '')
        const stage = args.stage as StageId
        const credName = STAGE_CREDENTIAL[stage]
        if (credName) {
          const need = ctx.credential(credName, args.credential as string | undefined)
          if (need) return need
        }
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Run the "${stage}" stage on project "${projectId}" and re-render it plus every downstream stage. ` +
            'This overwrites the project\'s intermediate render artifacts' +
            (stage === 'cut-review' ? ' and re-applies the validated cuts to the trimmed video.' : '.')
        )
        if (gate) return gate
        return ctx.invoke(CH.pipelineRunStage, projectId, stage, args.region as { start: number; end: number } | undefined)
      }
    },
    {
      name: `${MODULE_ID}__pipeline-run-full`,
      description:
        'Run the FULL auto-edit pipeline for a project in strict order: transcription, AI cut review, scene transitions, AI graphics planning, audio mix, preview render. Pauses at the graphics approval gate. Destructive: writes/overwrites every intermediate render artifact. Consumes your Whisper key (transcription) AND the routed AI-provider keys (cut review + graphics planning).',
      destructive: true,
      inputSchema: {
        projectId: z.string().describe('Project id.'),
        credential: z
          .string()
          .optional()
          .describe('OpenAI Whisper key. AI-provider keys are also consumed by later stages.'),
        confirm: z.boolean().optional().describe('Set true to actually run (see confirmation).')
      },
      handler: (args) => {
        const projectId = String(args.projectId ?? '')
        const need = ctx.credential('OpenAI API key (Whisper transcription)', args.credential as string | undefined)
        if (need) return need
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Run the full auto-edit pipeline on project "${projectId}" (transcription, AI cut review, transitions, ` +
            'graphics planning, audio mix, preview). Writes/overwrites all intermediate render artifacts and ' +
            'consumes Whisper and AI-provider API credits. It pauses at the graphics approval gate.'
        )
        if (gate) return gate
        return ctx.invoke(CH.pipelineRun, projectId)
      }
    },
    {
      name: `${MODULE_ID}__approve-graphics`,
      description:
        'Approve the planned graphics for a project (optionally with edits), render them (HyperFrames) and composite them into the video, then continue the audio + preview renders. This commits the stage-4 approval gate. Destructive: overwrites the graphics/audio/preview artifacts. No credential (planning already happened; rendering is local).',
      destructive: true,
      inputSchema: {
        projectId: z.string().describe('Project id.'),
        approvedIds: z
          .array(z.string())
          .describe('Ids of planned graphic events to approve (from project-open edl.graphics).'),
        edits: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('Optional full graphic-event objects carrying your edits to the plan (slots, timing, template).'),
        confirm: z.boolean().optional().describe('Set true to actually approve + render (see confirmation).')
      },
      handler: (args) => {
        const projectId = String(args.projectId ?? '')
        const approvedIds = (args.approvedIds as string[] | undefined) ?? []
        const edits = (args.edits as unknown[] | undefined) ?? []
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Approve ${approvedIds.length} planned graphic(s) for project "${projectId}", render and composite them into ` +
            'the video, then continue the audio + preview renders. This overwrites the graphics, audio and preview artifacts.'
        )
        if (gate) return gate
        return ctx.invoke(CH.pipelineApproveGraphics, projectId, approvedIds, edits)
      }
    },
    {
      name: `${MODULE_ID}__approve-final`,
      description:
        'Mark a project as approved (final render signed off). This is a reversible state flag and the prerequisite for shorts-generate. No files are written.',
      inputSchema: {
        projectId: z.string().describe('Project id to mark approved.')
      },
      handler: (args) => ctx.invoke(CH.approveFinal, String(args.projectId ?? ''))
    },
    {
      name: `${MODULE_ID}__export-final`,
      description:
        'Export the final full-quality video for a project using an export preset. Destructive: runs a full render and writes/overwrites the project\'s final output file. No credential (local ffmpeg).',
      destructive: true,
      inputSchema: {
        projectId: z.string().describe('Project id.'),
        presetId: z
          .enum(['yt-1080p', 'vertical-1080'])
          .describe('Export preset: "yt-1080p" (1920x1080 landscape) or "vertical-1080" (1080x1920 Shorts/Reels).'),
        confirm: z.boolean().optional().describe('Set true to actually export (see confirmation).')
      },
      handler: (args) => {
        const projectId = String(args.projectId ?? '')
        const presetId = String(args.presetId ?? '')
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Export the final video for project "${projectId}" using preset "${presetId}". This runs a full-quality ` +
            'render and writes/overwrites the project\'s final output file.'
        )
        if (gate) return gate
        return ctx.invoke(CH.exportFinal, projectId, presetId)
      }
    },

    // -- Shorts --------------------------------------------------------------
    {
      name: `${MODULE_ID}__shorts-generate`,
      description:
        'Generate short clips for a project via OpusClip. Uploads the approved final render to your configured S3 bucket (to make it URL-reachable) and submits it to OpusClip, which consumes OpusClip credits. Requires the final render to be exported and approved first. Destructive + credential.',
      destructive: true,
      inputSchema: {
        projectId: z.string().describe('Project id (must be approved with a final render).'),
        credential: z
          .string()
          .optional()
          .describe('OpusClip API key (plus S3 hosting credentials, used for the upload).'),
        confirm: z.boolean().optional().describe('Set true to actually upload + submit (see confirmation).')
      },
      handler: (args) => {
        const projectId = String(args.projectId ?? '')
        const need = ctx.credential(
          'OpusClip API key (plus S3 hosting credentials for the upload)',
          args.credential as string | undefined
        )
        if (need) return need
        const gate = ctx.confirm(
          args.confirm as boolean | undefined,
          `Generate shorts for project "${projectId}": upload the approved final render to your configured S3 bucket ` +
            '(making it reachable by URL) and submit it to OpusClip, which consumes OpusClip credits.'
        )
        if (gate) return gate
        return ctx.invoke(CH.shortsGenerate, projectId)
      }
    },

    // -- Queue ---------------------------------------------------------------
    {
      name: `${MODULE_ID}__queue-list`,
      description: 'List the render/export queue jobs (kind, label, status, progress). Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(CH.queueList)
    },
    {
      name: `${MODULE_ID}__queue-cancel`,
      description: 'Cancel a queued or running render/export job by its job id (from queue-list).',
      inputSchema: {
        jobId: z.string().describe('Job id to cancel.')
      },
      handler: (args) => ctx.invoke(CH.queueCancel, String(args.jobId ?? ''))
    }
  ]
}
