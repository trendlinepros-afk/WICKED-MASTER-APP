/**
 * Live lookups for the Domain and SSL trackers (main process).
 *   - DNS: A / AAAA / MX / NS / TXT / CNAME via the OS resolver, with hints
 *     ("Microsoft 365 mail", "Cloudflare DNS") derived from the records.
 *   - WHOIS-style registration data via RDAP (the registries' JSON WHOIS;
 *     rdap.org redirects to the right registry; no key, no scraping).
 *   - TLS: connect to host:port, read the certificate, check name + chain.
 * Everything fails soft into an `error` string — a lookup never throws.
 */
import { promises as dns } from 'dns'
import { connect as tlsConnect, checkServerIdentity, type PeerCertificate } from 'tls'
import type { DnsRecords, DomainLookup, SslLookup } from '../types'

const TIMEOUT_MS = 12_000

const ymd = (d: Date): string =>
  Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/** "example.com" from anything the user typed (URL, trailing dot, www.). */
export function normalizeDomain(input: string): string {
  let s = input.trim().toLowerCase()
  s = s.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0]
  s = s.replace(/\.$/, '')
  return s
}

/* --------------------------------- DNS --------------------------------- */

const soft = async <T>(p: Promise<T>, empty: T): Promise<T> => {
  try {
    return await Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS))])
  } catch {
    return empty
  }
}

export function dnsHints(r: Omit<DnsRecords, 'hints'>): string[] {
  const hints: string[] = []
  const mx = r.mx.map((m) => m.exchange.toLowerCase()).join(' ')
  const ns = r.ns.map((n) => n.toLowerCase()).join(' ')
  const txt = r.txt.map((t) => t.toLowerCase()).join(' ')
  if (/protection\.outlook\.com|mail\.protection/.test(mx)) hints.push('Mail: Microsoft 365')
  else if (/aspmx.*google|googlemail|smtp\.google\.com/.test(mx)) hints.push('Mail: Google Workspace')
  else if (/pphosted\.com/.test(mx)) hints.push('Mail: Proofpoint')
  else if (/mimecast/.test(mx)) hints.push('Mail: Mimecast')
  else if (/barracuda/.test(mx)) hints.push('Mail: Barracuda')
  else if (/messagelabs|symantec/.test(mx)) hints.push('Mail: Symantec / Broadcom')
  else if (/zoho/.test(mx)) hints.push('Mail: Zoho')
  else if (r.mx.length) hints.push(`Mail: ${r.mx[0].exchange}`)
  if (/cloudflare/.test(ns)) hints.push('DNS: Cloudflare')
  else if (/awsdns/.test(ns)) hints.push('DNS: AWS Route 53')
  else if (/domaincontrol\.com/.test(ns)) hints.push('DNS: GoDaddy')
  else if (/azure-dns/.test(ns)) hints.push('DNS: Azure DNS')
  else if (/googledomains|google\.com/.test(ns)) hints.push('DNS: Google')
  else if (/registrar-servers|namecheap/.test(ns)) hints.push('DNS: Namecheap')
  else if (/wixdns/.test(ns)) hints.push('DNS: Wix')
  else if (/squarespace/.test(ns)) hints.push('DNS: Squarespace')
  else if (r.ns.length) hints.push(`DNS: ${r.ns[0]}`)
  if (/v=spf1/.test(txt)) hints.push('SPF record present')
  if (/ms=|microsoft/.test(txt) && !/protection\.outlook/.test(mx)) hints.push('Microsoft verification TXT')
  if (/google-site-verification/.test(txt)) hints.push('Google verification TXT')
  return hints
}

export async function lookupDns(domain: string): Promise<DnsRecords> {
  const d = normalizeDomain(domain)
  const [a, aaaa, mx, ns, txt, cname] = await Promise.all([
    soft(dns.resolve4(d), [] as string[]),
    soft(dns.resolve6(d), [] as string[]),
    soft(dns.resolveMx(d), [] as { exchange: string; priority: number }[]),
    soft(dns.resolveNs(d), [] as string[]),
    soft(dns.resolveTxt(d), [] as string[][]),
    soft(dns.resolveCname(d), [] as string[])
  ])
  const base = {
    a,
    aaaa,
    mx: [...mx].sort((x, y) => x.priority - y.priority),
    ns,
    txt: txt.map((parts) => parts.join('')),
    cname
  }
  return { ...base, hints: dnsHints(base) }
}

/* --------------------------------- RDAP --------------------------------- */

interface RdapJson {
  ldhName?: string
  status?: string[]
  events?: { eventAction?: string; eventDate?: string }[]
  entities?: { roles?: string[]; vcardArray?: unknown; handle?: string; entities?: unknown[] }[]
  nameservers?: { ldhName?: string }[]
  errorCode?: number
  title?: string
}

function vcardName(vcard: unknown): string {
  // ["vcard", [["version",{},"text","4.0"],["fn",{},"text","GoDaddy.com, LLC"], …]]
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return ''
  for (const entry of vcard[1] as unknown[]) {
    if (Array.isArray(entry) && entry[0] === 'fn' && typeof entry[3] === 'string') return entry[3]
  }
  return ''
}

/** Pull the registrar and dates out of an RDAP document (pure). */
export function parseRdap(j: RdapJson): Omit<DomainLookup, 'checkedAt' | 'dns' | 'error'> {
  const ev = (action: RegExp): string => {
    const e = (j.events ?? []).find((x) => action.test(String(x.eventAction ?? '')))
    return e?.eventDate ? ymd(new Date(e.eventDate)) : ''
  }
  let registrar = ''
  const walk = (ents: RdapJson['entities'] | undefined): void => {
    for (const e of ents ?? []) {
      if (!registrar && (e.roles ?? []).includes('registrar')) registrar = vcardName(e.vcardArray) || e.handle || ''
      if (Array.isArray(e.entities)) walk(e.entities as RdapJson['entities'])
    }
  }
  walk(j.entities)
  return {
    registrar,
    expires: ev(/expiration/i),
    registered: ev(/registration/i),
    updated: ev(/last changed|last update/i),
    status: (j.status ?? []).map((s) => s.replace(/ /g, ' ')),
    nameservers: (j.nameservers ?? []).map((n) => (n.ldhName ?? '').toLowerCase()).filter(Boolean)
  }
}

export async function lookupDomain(domain: string, fetchFn: typeof fetch = fetch): Promise<DomainLookup> {
  const d = normalizeDomain(domain)
  const checkedAt = Date.now()
  const base: DomainLookup = { checkedAt, registrar: '', expires: '', registered: '', updated: '', status: [], nameservers: [], dns: null, error: '' }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ...base, error: `"${domain}" doesn’t look like a domain name.` }
  const [dnsRes, rdapRes] = await Promise.allSettled([
    lookupDns(d),
    (async () => {
      const resp = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(d)}`, {
        headers: { Accept: 'application/rdap+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (resp.status === 404) throw new Error('No registration found (unregistered, or a TLD without public RDAP).')
      if (!resp.ok) throw new Error(`Registry lookup failed (HTTP ${resp.status}).`)
      return parseRdap((await resp.json()) as RdapJson)
    })()
  ])
  const out = { ...base, dns: dnsRes.status === 'fulfilled' ? dnsRes.value : null }
  if (rdapRes.status === 'fulfilled') Object.assign(out, rdapRes.value)
  else out.error = rdapRes.reason instanceof Error ? rdapRes.reason.message : String(rdapRes.reason)
  return out
}

/* ---------------------------------- TLS ---------------------------------- */

export function lookupSsl(hostInput: string, port = 443): Promise<SslLookup> {
  const host = normalizeDomain(hostInput)
  const checkedAt = Date.now()
  const base: SslLookup = { checkedAt, subject: '', issuer: '', validFrom: '', validTo: '', daysLeft: 0, altNames: [], serial: '', valid: false, error: '' }
  return new Promise((resolve) => {
    let done = false
    const finish = (r: SslLookup): void => {
      if (done) return
      done = true
      resolve(r)
    }
    let sock: ReturnType<typeof tlsConnect>
    try {
      sock = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
        const cert = sock.getPeerCertificate(false) as PeerCertificate & { subjectaltname?: string }
        if (!cert || !cert.valid_to) {
          sock.destroy()
          return finish({ ...base, error: 'The server did not present a certificate.' })
        }
        const to = new Date(cert.valid_to)
        const nameOk = !checkServerIdentity(host, cert)
        const one = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : v == null ? '' : String(v))
        const issuer = cert.issuer ? [one(cert.issuer.O), one(cert.issuer.CN)].filter(Boolean).join(' — ') : ''
        const out: SslLookup = {
          checkedAt,
          subject: one(cert.subject?.CN),
          issuer,
          validFrom: ymd(new Date(cert.valid_from)),
          validTo: ymd(to),
          daysLeft: Math.floor((to.getTime() - checkedAt) / 86_400_000),
          altNames: (cert.subjectaltname ?? '')
            .split(',')
            .map((s) => s.trim().replace(/^DNS:/i, ''))
            .filter(Boolean),
          serial: cert.serialNumber ?? '',
          valid: sock.authorized && nameOk,
          error: !sock.authorized ? `Chain not trusted: ${sock.authorizationError}` : !nameOk ? 'Certificate name does not match the host.' : ''
        }
        sock.destroy()
        finish(out)
      })
    } catch (err) {
      return finish({ ...base, error: err instanceof Error ? err.message : String(err) })
    }
    sock.on('timeout', () => {
      sock.destroy()
      finish({ ...base, error: 'Connection timed out.' })
    })
    sock.on('error', (err) => finish({ ...base, error: err.message }))
  })
}
