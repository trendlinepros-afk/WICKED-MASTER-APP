/**
 * Minimal GitHub client for Cloud Sync. Uses the Git Data API for uploads so a
 * snapshot up to ~100 MB works (the simpler Contents API silently truncates
 * blobs over 1 MB), and the raw media type for downloads (also large-file safe).
 *
 * Only two files ever live in the sync repo:
 *   - wicked-sync.enc            the password-encrypted snapshot (opaque blob)
 *   - wicked-sync-manifest.json  small PLAINTEXT metadata (version/time/device)
 *
 * The token is a fine-grained PAT scoped to the one private repo (Contents:
 * read+write). Everything is fail-soft: network/permission errors return a
 * message, never throw.
 */

const API = 'https://api.github.com'
const TIMEOUT_MS = 45_000

export const BLOB_PATH = 'wicked-sync.enc'
export const MANIFEST_PATH = 'wicked-sync-manifest.json'
const COMMIT_MSG = 'WICKED cloud sync snapshot'

export interface GhResult {
  ok: boolean
  status: number
  json?: unknown
  text?: string
  error?: string
}

function headers(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'WICKED-Suite'
  }
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  accept?: string
): Promise<GhResult> {
  let resp: Response
  try {
    resp = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...headers(token, accept),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) }
  }
  const raw = accept === 'application/vnd.github.raw'
  const text = await resp.text().catch(() => '')
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`
    try {
      const j = JSON.parse(text) as { message?: string }
      if (j?.message) detail = j.message
    } catch {
      /* non-JSON error body */
    }
    if (resp.status === 401) detail = 'GitHub rejected the token (401). Check it in Settings → Cloud Sync.'
    else if (resp.status === 403) detail = `GitHub denied access (403). The token needs Contents: read & write on this repo. (${detail})`
    else if (resp.status === 404) detail = 'Repo or path not found (404). Check "owner/name" and that the token can see this private repo.'
    return { ok: false, status: resp.status, error: detail }
  }
  if (raw) return { ok: true, status: resp.status, text }
  try {
    return { ok: true, status: resp.status, json: text ? JSON.parse(text) : {} }
  } catch {
    return { ok: true, status: resp.status, text }
  }
}

/** Validate the repo + token, returning its default branch and privacy. */
export async function getRepoInfo(
  token: string,
  repo: string
): Promise<{ ok: boolean; defaultBranch?: string; private?: boolean; error?: string }> {
  const r = await gh(token, 'GET', `/repos/${repo}`)
  if (!r.ok) return { ok: false, error: r.error }
  const j = (r.json ?? {}) as { default_branch?: string; private?: boolean }
  return { ok: true, defaultBranch: j.default_branch ?? 'main', private: j.private === true }
}

export interface PullOut {
  ok: boolean
  notFound?: boolean
  manifestText?: string
  blobText?: string
  error?: string
}

/** Download the manifest + encrypted blob at a git ref (branch OR commit sha). */
async function pullAtRef(token: string, repo: string, ref: string): Promise<PullOut> {
  const r = encodeURIComponent(ref)
  const man = await gh(token, 'GET', `/repos/${repo}/contents/${MANIFEST_PATH}?ref=${r}`, undefined, 'application/vnd.github.raw')
  if (man.status === 404) return { ok: true, notFound: true }
  if (!man.ok) return { ok: false, error: man.error }
  const blob = await gh(token, 'GET', `/repos/${repo}/contents/${BLOB_PATH}?ref=${r}`, undefined, 'application/vnd.github.raw')
  if (blob.status === 404) return { ok: true, notFound: true }
  if (!blob.ok) return { ok: false, error: blob.error }
  return { ok: true, manifestText: man.text ?? '', blobText: blob.text ?? '' }
}

/** Download the manifest + encrypted blob from the tip of `branch`. */
export async function pullRemote(token: string, repo: string, branch: string): Promise<PullOut> {
  return pullAtRef(token, repo, branch)
}

/** Download the manifest + encrypted blob as they were at a specific commit. */
export async function pullSnapshotAt(token: string, repo: string, commitSha: string): Promise<PullOut> {
  return pullAtRef(token, repo, commitSha)
}

export interface RawSnapshot {
  commitSha: string
  commitDate: string
  /** the manifest JSON as it existed at that commit, or null if it couldn't be read */
  manifestText: string | null
}

/**
 * List past snapshots by walking the commits that touched the manifest — every
 * push is a commit, so the whole history is restorable. Fetches each commit's
 * manifest (in parallel) so the caller gets version/device/time per snapshot.
 */
export async function listSnapshots(
  token: string,
  repo: string,
  branch: string,
  limit = 40
): Promise<{ ok: boolean; items?: RawSnapshot[]; error?: string }> {
  const ref = encodeURIComponent(branch)
  const per = Math.min(Math.max(limit, 1), 100)
  const commitsRes = await gh(token, 'GET', `/repos/${repo}/commits?sha=${ref}&path=${encodeURIComponent(MANIFEST_PATH)}&per_page=${per}`)
  if (commitsRes.status === 404 || commitsRes.status === 409) return { ok: true, items: [] } // empty repo / no history yet
  if (!commitsRes.ok) return { ok: false, error: commitsRes.error }
  const commits = Array.isArray(commitsRes.json)
    ? (commitsRes.json as Array<{ sha?: string; commit?: { committer?: { date?: string }; author?: { date?: string } } }>)
    : []
  const items = await Promise.all(
    commits.map(async (c): Promise<RawSnapshot | null> => {
      const sha = c.sha ?? ''
      if (!sha) return null
      const commitDate = c.commit?.committer?.date ?? c.commit?.author?.date ?? ''
      const man = await gh(token, 'GET', `/repos/${repo}/contents/${MANIFEST_PATH}?ref=${sha}`, undefined, 'application/vnd.github.raw')
      return { commitSha: sha, commitDate, manifestText: man.ok ? man.text ?? null : null }
    })
  )
  return { ok: true, items: items.filter((x): x is RawSnapshot => x !== null) }
}

/** Fetch just the plaintext manifest (to preview a pull without downloading the blob). */
export async function pullManifest(token: string, repo: string, branch: string): Promise<{ ok: boolean; notFound?: boolean; manifestText?: string; error?: string }> {
  const ref = encodeURIComponent(branch)
  const man = await gh(token, 'GET', `/repos/${repo}/contents/${MANIFEST_PATH}?ref=${ref}`, undefined, 'application/vnd.github.raw')
  if (man.status === 404) return { ok: true, notFound: true }
  if (!man.ok) return { ok: false, error: man.error }
  return { ok: true, manifestText: man.text ?? '' }
}

async function createBlob(token: string, repo: string, text: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
  const r = await gh(token, 'POST', `/repos/${repo}/git/blobs`, {
    content: Buffer.from(text, 'utf8').toString('base64'),
    encoding: 'base64'
  })
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, sha: (r.json as { sha?: string }).sha }
}

/**
 * Commit both files (blob + manifest) atomically on `branch`, creating the
 * branch/first commit if the repo is empty. Returns ok or an error message.
 */
export async function pushSnapshot(
  token: string,
  repo: string,
  branch: string,
  blobText: string,
  manifestText: string
): Promise<{ ok: boolean; error?: string }> {
  // 1) current branch tip (may not exist yet)
  const refPath = `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  const refRes = await gh(token, 'GET', refPath)
  let parentSha: string | null = null
  let baseTree: string | undefined
  if (refRes.ok) {
    parentSha = (refRes.json as { object?: { sha?: string } }).object?.sha ?? null
    if (parentSha) {
      const commit = await gh(token, 'GET', `/repos/${repo}/git/commits/${parentSha}`)
      if (commit.ok) baseTree = (commit.json as { tree?: { sha?: string } }).tree?.sha
    }
  } else if (refRes.status !== 404 && refRes.status !== 409) {
    return { ok: false, error: refRes.error }
  }

  // 1b) The Git Data object endpoints refuse to run on a repo with ZERO commits
  // ("Git Repository is empty"). Seed an initial commit via the Contents API —
  // the one endpoint that works on an empty repo — then build on top of it.
  if (!parentSha) {
    const seed = await gh(token, 'PUT', `/repos/${repo}/contents/README.md`, {
      message: 'Initialize WICKED sync',
      content: Buffer.from(
        '# WICKED cloud sync\n\nEncrypted WICKED app snapshots. Managed by the app — do not edit by hand.\n',
        'utf8'
      ).toString('base64')
    })
    if (!seed.ok) return { ok: false, error: seed.error }
    const seededSha = (seed.json as { commit?: { sha?: string } }).commit?.sha ?? null
    if (seededSha) {
      parentSha = seededSha
      const c = await gh(token, 'GET', `/repos/${repo}/git/commits/${seededSha}`)
      if (c.ok) baseTree = (c.json as { tree?: { sha?: string } }).tree?.sha
    } else {
      const ref2 = await gh(token, 'GET', refPath)
      if (ref2.ok) parentSha = (ref2.json as { object?: { sha?: string } }).object?.sha ?? null
    }
  }

  // 2) blobs
  const b1 = await createBlob(token, repo, blobText)
  if (!b1.ok || !b1.sha) return { ok: false, error: b1.error ?? 'Could not upload the snapshot blob.' }
  const b2 = await createBlob(token, repo, manifestText)
  if (!b2.ok || !b2.sha) return { ok: false, error: b2.error ?? 'Could not upload the manifest.' }

  // 3) tree
  const treeRes = await gh(token, 'POST', `/repos/${repo}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: [
      { path: BLOB_PATH, mode: '100644', type: 'blob', sha: b1.sha },
      { path: MANIFEST_PATH, mode: '100644', type: 'blob', sha: b2.sha }
    ]
  })
  if (!treeRes.ok) return { ok: false, error: treeRes.error }
  const treeSha = (treeRes.json as { sha?: string }).sha
  if (!treeSha) return { ok: false, error: 'GitHub did not return a tree sha.' }

  // 4) commit
  const commitRes = await gh(token, 'POST', `/repos/${repo}/git/commits`, {
    message: COMMIT_MSG,
    tree: treeSha,
    parents: parentSha ? [parentSha] : []
  })
  if (!commitRes.ok) return { ok: false, error: commitRes.error }
  const commitSha = (commitRes.json as { sha?: string }).sha
  if (!commitSha) return { ok: false, error: 'GitHub did not return a commit sha.' }

  // 5) point the branch at the new commit — update if it exists, else create it
  // (covers a seeded default branch whose name differs from `branch`).
  const upd = await gh(token, 'PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commitSha, force: false })
  if (!upd.ok) {
    if (upd.status === 404 || upd.status === 422) {
      const cr = await gh(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha })
      if (!cr.ok) return { ok: false, error: cr.error }
    } else {
      return { ok: false, error: upd.error }
    }
  }
  return { ok: true }
}
