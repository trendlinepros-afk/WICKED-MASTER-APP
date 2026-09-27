import { z } from 'zod'
import type { McpModuleContext, McpToolDef } from '@shared/mcp'

/**
 * MCP tools for DOCUMENTATION. Every tool delegates to the same main-process
 * channel the UI calls (ipc.ts). All of them require the vault to be unlocked
 * in the app (they return {locked:true} otherwise) and NONE of them can
 * reveal a secret — passwords, TOTP seeds and licence keys come back as
 * placeholders, exactly as the renderer sees them. Update/delete are
 * destructive and go through the shared confirmation gate.
 */
const ID = 'documentation'

export default function register(ctx: McpModuleContext): McpToolDef[] {
  return [
    {
      name: `${ID}__status`,
      description: 'Whether Documentation has a password set and is currently unlocked in the app. Read-only.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:status`)
    },
    {
      name: `${ID}__types`,
      description: 'List asset types (Configurations, Contacts, Passwords, Domains, LAN, Wireless, …) with their field definitions and record counts. Read-only; needs the vault unlocked.',
      inputSchema: {},
      handler: () => ctx.invoke(`${ID}:types`)
    },
    {
      name: `${ID}__list`,
      description: 'List records of one asset type (name + list columns), optionally filtered by a search term. Secrets are never included. Read-only.',
      inputSchema: {
        type: z.string().describe('Asset type id, e.g. "configuration", "password", "domain"'),
        q: z.string().optional().describe('Substring filter over name, tags and field values'),
        archived: z.boolean().optional()
      },
      handler: (args) => ctx.invoke(`${ID}:records`, { type: args.type, q: args.q, archived: args.archived === true })
    },
    {
      name: `${ID}__get`,
      description: 'One record with all its fields (secret fields are placeholders, never values), related items and attachments. Read-only.',
      inputSchema: { id: z.string() },
      handler: (args) => ctx.invoke(`${ID}:record`, { id: args.id })
    },
    {
      name: `${ID}__search`,
      description: 'Search every asset type by name, tag or field value. Returns up to 80 matches. Read-only.',
      inputSchema: { q: z.string() },
      handler: (args) => ctx.invoke(`${ID}:search`, { q: args.q })
    },
    {
      name: `${ID}__expirations`,
      description: 'Domains, SSL certificates, licences, warranties and contracts expiring within N days (default 90), soonest first. Read-only.',
      inputSchema: { days: z.number().int().positive().max(3650).optional() },
      handler: (args) => ctx.invoke(`${ID}:expirations`, { days: args.days })
    },
    {
      name: `${ID}__create`,
      description:
        'Create a record. `fields` uses the type’s field keys (see types). Secret fields (password/totp kinds) are encrypted on save. Relation fields take arrays of record ids. Dates are YYYY-MM-DD.',
      inputSchema: {
        type: z.string(),
        name: z.string(),
        fields: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string()).optional(),
        folder: z.string().optional().describe('Documents only: folder path like "Onboarding/Laptops"')
      },
      handler: (args) => ctx.invoke(`${ID}:record-save`, { type: args.type, name: args.name, fields: args.fields ?? {}, tags: args.tags ?? [], folder: args.folder ?? '' })
    },
    {
      name: `${ID}__update`,
      description: 'Overwrite a record’s name/fields/tags. Fields you omit are cleared, so pass the full set (get the record first). Destructive; requires confirm:true.',
      destructive: true,
      inputSchema: {
        id: z.string(),
        name: z.string(),
        fields: z.record(z.string(), z.unknown()).optional(),
        tags: z.array(z.string()).optional(),
        folder: z.string().optional(),
        confirm: z.boolean().optional()
      },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Overwrite record ${String(args.id)} ("${String(args.name)}") with the supplied fields; omitted fields are cleared.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:record-save`, { id: args.id, name: args.name, fields: args.fields ?? {}, tags: args.tags ?? [], folder: args.folder ?? '' })
      }
    },
    {
      name: `${ID}__delete`,
      description: 'Permanently delete a record and its attachments. Prefer archiving (update is not needed — use the app). Destructive; requires confirm:true.',
      destructive: true,
      inputSchema: { id: z.string(), confirm: z.boolean().optional() },
      handler: (args) => {
        const gate = ctx.confirm(args.confirm as boolean | undefined, `Permanently delete record ${String(args.id)} and its attachments. This cannot be undone.`)
        if (gate) return gate
        return ctx.invoke(`${ID}:record-delete`, { id: args.id })
      }
    },
    {
      name: `${ID}__lookup-domain`,
      description: 'Run the live DNS + registry (RDAP/WHOIS) lookup for a Domain record and store the result on it (registrar, expiry, name servers, MX/NS/TXT). Network access.',
      inputSchema: { id: z.string() },
      handler: (args) => ctx.invoke(`${ID}:lookup-domain`, { id: args.id })
    },
    {
      name: `${ID}__lookup-ssl`,
      description: 'Connect to an SSL Certificate record’s host and store the certificate’s issuer, expiry and validity on it. Network access.',
      inputSchema: { id: z.string() },
      handler: (args) => ctx.invoke(`${ID}:lookup-ssl`, { id: args.id })
    }
  ]
}
