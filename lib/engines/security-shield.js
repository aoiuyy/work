import path from 'node:path';

// Blocked secret and sensitive files
const BLOCKED_SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /token.*\.dpapi$/i,
  /\.npmrc$/i,
  /\.dockercfg$/i,
  /docker\/config\.json$/i,
];

// Blocked Git configuration or hook files (prevents RCE attacks via git hooks)
const BLOCKED_GIT_INJECTION_PATTERNS = [
  /^\.git[\\/]hooks[\\/]/i,
  /^\.git[\\/]config$/i,
  /^\.git[\\/]description$/i,
  /^\.gitattributes$/i,
];

// Dangerous executable file extensions to quarantine
const QUARANTINE_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.com',
  '.scr',
  '.bat',
  '.cmd',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js.bin',
  '.wsf',
  '.cpl',
  '.hta',
  '.msi',
]);

// Secret regex scanner inside file content
const CONTENT_SECRET_REGEXES = [
  { name: 'GitHub Personal Access Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/ },
  { name: 'GitHub Fine-grained PAT', pattern: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9_]{59}/ },
  { name: 'OpenAI / DeepSeek API Key', pattern: /sk-[A-Za-z0-9_-]{20,64}/ },
  { name: 'Slack Bot Token', pattern: /xoxb-[0-9]{11,13}-[0-9]{11,13}-[a-zA-Z0-9]{24}/ },
  { name: 'AWS Access Key ID', pattern: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/ },
  { name: 'Private Key Header', pattern: /-----BEGIN (?:RSA|OPENSSH|DSA|EC|PGP)? PRIVATE KEY-----/ },
];

/**
 * Validates whether a file relative path is secure and free of path traversal.
 */
export function isPathSafe(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) return false;
  if (relativePath.includes('\0')) return false;
  const normalized = path.normalize(relativePath).replace(/\\/g, '/');
  if (normalized.startsWith('../') || normalized === '..' || path.isAbsolute(normalized)) {
    return false;
  }
  return true;
}

/**
 * Analyzes a relative file path against secret patterns, git hook injections, and quarantines.
 */
export function inspectFilePath(relativePath) {
  if (!isPathSafe(relativePath)) {
    return {
      allowed: false,
      reason: 'Path traversal or invalid path detected',
      type: 'PATH_TRAVERSAL',
    };
  }

  const baseName = path.basename(relativePath);
  const ext = path.extname(relativePath).toLowerCase();

  for (const pattern of BLOCKED_SECRET_PATTERNS) {
    if (pattern.test(baseName) || pattern.test(relativePath)) {
      return {
        allowed: false,
        reason: `Sensitive file pattern detected: ${baseName}`,
        type: 'SECRET_FILE_BLOCKED',
      };
    }
  }

  for (const pattern of BLOCKED_GIT_INJECTION_PATTERNS) {
    if (pattern.test(relativePath)) {
      return {
        allowed: false,
        reason: 'Git hook or internal configuration injection detected',
        type: 'GIT_INJECTION_BLOCKED',
      };
    }
  }

  if (QUARANTINE_EXTENSIONS.has(ext)) {
    return {
      allowed: true,
      quarantine: true,
      reason: `Executable extension ${ext} placed in quarantine`,
      type: 'BINARY_QUARANTINE',
    };
  }

  return { allowed: true, quarantine: false, reason: null };
}

/**
 * Scans text content (or git diff) for accidental credentials or private keys.
 */
export function scanContentSecrets(content) {
  if (!content || typeof content !== 'string') return [];
  const findings = [];
  for (const check of CONTENT_SECRET_REGEXES) {
    if (check.pattern.test(content)) {
      findings.push(check.name);
    }
  }
  return findings;
}

/**
 * Scans an array of changed files and optional diff content.
 */
export function auditChangeset(files = [], diffText = '') {
  const rejected = [];
  const quarantined = [];
  const approved = [];

  for (const file of files) {
    const inspection = inspectFilePath(file);
    if (!inspection.allowed) {
      rejected.push({ file, reason: inspection.reason, type: inspection.type });
    } else if (inspection.quarantine) {
      quarantined.push({ file, reason: inspection.reason });
      approved.push(file);
    } else {
      approved.push(file);
    }
  }

  const secretFindings = scanContentSecrets(diffText);

  return {
    safe: rejected.length === 0 && secretFindings.length === 0,
    approvedFiles: approved,
    rejectedFiles: rejected,
    quarantinedFiles: quarantined,
    secretFindings,
    totalFiles: files.length,
  };
}
