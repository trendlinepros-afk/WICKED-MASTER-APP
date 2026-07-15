import type { Language, Severity, VulnIssue } from '../shared/types'
import type { ScannedProject } from './scanner'

interface Rule {
  id: string
  title: string
  severity: Severity
  /** Languages this rule applies to; 'all' runs everywhere content was parsed. */
  languages: Language[] | 'all'
  pattern: RegExp
  /** If this matches the same line, the finding is suppressed (env lookups, placeholders…). */
  negative?: RegExp
  /** Skip lines that look like comments. */
  skipComments?: boolean
  description: string
  recommendation: string
}

const PLACEHOLDER = /(process\.env|os\.environ|getenv|import\.meta\.env|\$\{|\{\{|<[^>]*>|your[_-]?|x{4,}|example|placeholder|changeme|change[_-]me|dummy|sample|TODO|REDACTED)/i

const CODE_LANGS: Language[] = ['javascript', 'typescript', 'python', 'csharp', 'php', 'go']

const RULES: Rule[] = [
  {
    id: 'known-token',
    title: 'Hardcoded credential token',
    severity: 'critical',
    languages: 'all',
    pattern:
      /(sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{24,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/,
    description:
      'This looks like a real API token (Anthropic, AWS, GitHub, Slack, or Google format) committed directly into the codebase. Anyone with read access to this repo can use it.',
    recommendation:
      'Revoke this token immediately, then load it from an environment variable or a secrets manager instead of the source code. Add the file to .gitignore if it must hold local secrets.'
  },
  {
    id: 'private-key',
    title: 'Private key material in source',
    severity: 'critical',
    languages: 'all',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    description: 'A PEM-encoded private key is embedded in this file. Private keys in source control are effectively public to everyone with repo access.',
    recommendation: 'Remove the key, rotate it, and load keys from secure storage (key vault, encrypted file outside the repo, or environment configuration).'
  },
  {
    id: 'secret-assignment',
    title: 'Possible hardcoded secret',
    severity: 'high',
    languages: 'all',
    pattern:
      /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']([^"']{10,})["']/i,
    negative: PLACEHOLDER,
    description:
      'A variable named like a credential is assigned a long literal string. If this is a real secret, it is exposed to anyone who can read the code or the repository history.',
    recommendation: 'Move the value to an environment variable or secrets manager and reference it at runtime. If it was a real secret, rotate it.'
  },
  {
    id: 'env-secret',
    title: 'Secret committed in config file',
    severity: 'medium',
    languages: ['config'],
    pattern: /^\s*\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\w*\s*=\s*\S{8,}/i,
    negative: PLACEHOLDER,
    description: 'A config/.env entry that looks like a credential has a concrete value. Config files are frequently committed or copied by mistake.',
    recommendation: 'Keep real values in an untracked local file (e.g. .env.local in .gitignore) and commit only a template with empty values.'
  },
  {
    id: 'eval-usage',
    title: 'Use of eval()',
    severity: 'high',
    languages: ['javascript', 'typescript', 'python', 'php'],
    pattern: /(?<![.\w])eval\s*\(/,
    skipComments: true,
    description:
      'eval() executes arbitrary strings as code. If any part of the evaluated string can be influenced by user input, this becomes remote code execution.',
    recommendation: 'Replace eval with a safe alternative: JSON.parse for data, a lookup table for dynamic dispatch, or ast.literal_eval in Python.'
  },
  {
    id: 'new-function',
    title: 'Dynamic code via new Function()',
    severity: 'high',
    languages: ['javascript', 'typescript'],
    pattern: /\bnew\s+Function\s*\(/,
    skipComments: true,
    description: 'new Function() compiles strings into executable code at runtime — the same risk class as eval().',
    recommendation: 'Refactor to regular functions or a whitelisted dispatch map; never feed user-controlled strings into Function().'
  },
  {
    id: 'python-exec',
    title: 'Use of exec()',
    severity: 'medium',
    languages: ['python'],
    pattern: /(?<![.\w])exec\s*\(/,
    skipComments: true,
    description: 'exec() runs arbitrary Python source. Combined with any external input it allows full code injection.',
    recommendation: 'Avoid exec entirely; use importlib for dynamic imports or explicit function dispatch.'
  },
  {
    id: 'sql-concat',
    title: 'SQL built by string concatenation',
    severity: 'high',
    languages: ['javascript', 'typescript', 'php', 'csharp', 'python', 'go'],
    pattern: /["'`][^"'`]*\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)\b[^"'`]*["'`]\s*(?:\+|\.)\s*[\w$@]/i,
    skipComments: true,
    description:
      'A SQL statement is being assembled by concatenating strings with variables. If those variables carry user input, this is a classic SQL injection vector.',
    recommendation: 'Use parameterized queries / prepared statements (placeholders like ? or $1) and pass values separately from the SQL text.'
  },
  {
    id: 'sql-template',
    title: 'SQL built with template interpolation',
    severity: 'high',
    languages: ['javascript', 'typescript', 'python'],
    pattern: /(`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b[^`]*\$\{|f["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|DROP)\b[^"']*\{)/i,
    skipComments: true,
    description: 'A SQL statement interpolates variables directly into the query text (template literal or f-string) — the same injection risk as concatenation.',
    recommendation: 'Switch to parameterized queries; keep the SQL text static and bind the values.'
  },
  {
    id: 'xss-innerhtml',
    title: 'Direct innerHTML assignment',
    severity: 'medium',
    languages: ['javascript', 'typescript'],
    pattern: /\.(?:innerHTML|outerHTML)\s*=/,
    negative: /(DOMPurify|sanitize)/i,
    skipComments: true,
    description: 'Assigning to innerHTML renders raw HTML. If the value contains any user-supplied content, scripts can be injected (XSS).',
    recommendation: 'Use textContent for plain text, or sanitize the HTML with a library like DOMPurify before assignment.'
  },
  {
    id: 'xss-dangerously',
    title: 'dangerouslySetInnerHTML',
    severity: 'medium',
    languages: ['javascript', 'typescript'],
    pattern: /dangerouslySetInnerHTML/,
    negative: /(DOMPurify|sanitize)/i,
    description: 'React escapes content by default; dangerouslySetInnerHTML bypasses that protection and renders raw HTML.',
    recommendation: 'Sanitize the HTML (e.g. DOMPurify.sanitize) before passing it in, or restructure so React renders the content normally.'
  },
  {
    id: 'document-write',
    title: 'document.write()',
    severity: 'low',
    languages: ['javascript', 'typescript'],
    pattern: /document\.write\s*\(/,
    skipComments: true,
    description: 'document.write can inject unescaped markup and blocks rendering; it is also a common XSS sink.',
    recommendation: 'Build DOM nodes with createElement/textContent or a framework render path instead.'
  },
  {
    id: 'cmd-injection-js',
    title: 'Shell command built from variables',
    severity: 'high',
    languages: ['javascript', 'typescript'],
    pattern: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/,
    skipComments: true,
    description: 'child_process exec runs a shell. Interpolating variables into the command string lets crafted input run arbitrary commands.',
    recommendation: 'Use execFile/spawn with an argument array (no shell), or strictly validate/escape every interpolated value.'
  },
  {
    id: 'cmd-injection-py',
    title: 'os.system / shell=True',
    severity: 'high',
    languages: ['python'],
    pattern: /(os\.system\s*\(|subprocess\.\w+\([^)]*shell\s*=\s*True)/,
    skipComments: true,
    description: 'Running commands through a shell with dynamic input allows command injection.',
    recommendation: 'Use subprocess.run([...]) with a list of arguments and shell=False; validate any user-derived parts.'
  },
  {
    id: 'cmd-injection-php',
    title: 'Shell execution with variable input',
    severity: 'high',
    languages: ['php'],
    pattern: /\b(?:shell_exec|passthru|system|exec|popen)\s*\(\s*\$/,
    skipComments: true,
    description: 'A PHP shell-execution function is called with a variable. If that variable touches user input, attackers can run arbitrary commands.',
    recommendation: 'Avoid shelling out; if unavoidable, use escapeshellarg/escapeshellcmd on every dynamic piece.'
  },
  {
    id: 'insecure-pickle',
    title: 'Insecure deserialization (pickle)',
    severity: 'high',
    languages: ['python'],
    pattern: /pickle\.loads?\s*\(/,
    skipComments: true,
    description: 'Unpickling untrusted data executes arbitrary code by design. This is a frequent real-world RCE vector.',
    recommendation: 'Use JSON or another data-only format for untrusted input; reserve pickle for trusted, internal data.'
  },
  {
    id: 'insecure-yaml',
    title: 'yaml.load without SafeLoader',
    severity: 'medium',
    languages: ['python'],
    pattern: /yaml\.load\s*\((?![^)\n]*(?:SafeLoader|safe_load))/,
    skipComments: true,
    description: 'yaml.load with the default loader can instantiate arbitrary Python objects from the document.',
    recommendation: 'Use yaml.safe_load (or pass Loader=yaml.SafeLoader).'
  },
  {
    id: 'insecure-unserialize',
    title: 'PHP unserialize() on data',
    severity: 'medium',
    languages: ['php'],
    pattern: /\bunserialize\s*\(/,
    skipComments: true,
    description: 'unserialize on attacker-controlled strings enables PHP object injection.',
    recommendation: 'Use json_decode for untrusted data, or pass ["allowed_classes" => false] to unserialize.'
  },
  {
    id: 'weak-hash',
    title: 'Weak hash algorithm (MD5/SHA1)',
    severity: 'medium',
    languages: ['javascript', 'typescript', 'python', 'php', 'csharp', 'go'],
    pattern: /(createHash\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|\bmd5\s*\(|MD5CryptoServiceProvider|SHA1CryptoServiceProvider|md5\.New\(\)|sha1\.New\(\))/,
    skipComments: true,
    description: 'MD5 and SHA-1 are broken for security purposes (collisions are practical). Using them for passwords or signatures is unsafe.',
    recommendation: 'Use SHA-256+ for integrity, and a dedicated slow KDF (bcrypt, scrypt, argon2) for passwords.'
  },
  {
    id: 'http-url',
    title: 'Unencrypted http:// endpoint',
    severity: 'low',
    languages: CODE_LANGS,
    pattern: /["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])[^"']+["']/,
    negative: /(w3\.org|xmlns|schemas?\.|\.dtd|example\.com|expected|test)/i,
    skipComments: true,
    description: 'Plain HTTP traffic can be read and modified in transit. Credentials or tokens sent over it are exposed.',
    recommendation: 'Use https:// for every external endpoint; reserve http for localhost development.'
  },
  {
    id: 'require-in-ts',
    title: 'CommonJS require() in TypeScript',
    severity: 'low',
    languages: ['typescript'],
    pattern: /(?<![.\w])require\s*\(\s*["']/,
    skipComments: true,
    description: 'Mixing require() into TypeScript bypasses the type system for that import and signals outdated module patterns.',
    recommendation: 'Use ES module syntax (import x from "y") so the compiler can type-check and bundlers can tree-shake.'
  },
  {
    id: 'var-keyword',
    title: 'Outdated var declaration',
    severity: 'low',
    languages: ['javascript', 'typescript'],
    pattern: /^\s*var\s+[\w$]/,
    skipComments: true,
    description: 'var is function-scoped and hoisted, which causes subtle bugs; it usually marks older, unrefactored code.',
    recommendation: 'Use const (or let when reassignment is needed).'
  }
]

const COMMENT_PREFIXES = ['//', '#', '*', '/*', '<!--', ';', '--']
const MAX_ISSUES_PER_RULE_PER_FILE = 5
const MAX_LINE_LEN = 500

function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return COMMENT_PREFIXES.some((p) => t.startsWith(p))
}

export function scanVulnerabilities(project: ScannedProject): VulnIssue[] {
  const issues: VulnIssue[] = []

  for (const file of project.files) {
    const content = project.contents.get(file.relPath)
    if (!content) continue
    const lines = content.split('\n')
    const applicable = RULES.filter(
      (r) => r.languages === 'all' || r.languages.includes(file.language)
    )

    for (const rule of applicable) {
      let hits = 0
      for (let i = 0; i < lines.length && hits < MAX_ISSUES_PER_RULE_PER_FILE; i++) {
        const line = lines[i]
        if (line.length > MAX_LINE_LEN) continue // minified / generated
        if (rule.skipComments && isCommentLine(line)) continue
        if (!rule.pattern.test(line)) continue
        if (rule.negative && rule.negative.test(line)) continue
        hits++
        issues.push({
          id: `${rule.id}:${file.relPath}:${i + 1}`,
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          file: file.relPath,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
          description: rule.description,
          recommendation: rule.recommendation
        })
      }
    }

    // Heuristic: promise chains with no .catch anywhere in the file.
    if (
      (file.language === 'javascript' || file.language === 'typescript') &&
      content.includes('.then(') &&
      !content.includes('.catch')
    ) {
      let hits = 0
      for (let i = 0; i < lines.length && hits < 3; i++) {
        const line = lines[i]
        if (line.length > MAX_LINE_LEN || isCommentLine(line)) continue
        if (!line.includes('.then(')) continue
        hits++
        issues.push({
          id: `unhandled-promise:${file.relPath}:${i + 1}`,
          ruleId: 'unhandled-promise',
          title: 'Promise chain without .catch',
          severity: 'low',
          file: file.relPath,
          line: i + 1,
          snippet: line.trim().slice(0, 200),
          description:
            'This file uses .then() but never calls .catch(). A rejected promise here becomes an unhandled rejection, which can crash Node processes and silently swallow errors in the browser. (Heuristic — errors may be handled elsewhere, e.g. via try/await.)',
          recommendation: 'Attach a .catch() to each chain (or convert to async/await wrapped in try/catch) and decide deliberately how each failure should surface.'
        })
      }
    }
  }

  return issues
}
