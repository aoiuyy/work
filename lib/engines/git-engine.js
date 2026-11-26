import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { auditChangeset, inspectFilePath } from './security-shield.js';

const execFileAsync = promisify(execFile);

/**
 * Runs a Git command with timeout and safe buffer limits.
 */
export async function runGit(args, cwd, envExtra = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...envExtra,
      },
      windowsHide: true,
    });
    return { ok: true, stdout: stdout.replace(/^[\r\n]+|[\r\n]+$/g, ''), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      stderr: err.stderr ? err.stderr.trim() : '',
      stdout: err.stdout ? err.stdout.trim() : '',
    };
  }
}

/**
 * Checks if a directory is a valid Git repository and retrieves its current status.
 */
export async function getRepoStatus(repoDir) {
  if (!repoDir || typeof repoDir !== 'string') {
    return { isGit: false, error: 'Directory path required' };
  }

  const check = await runGit(['rev-parse', '--is-inside-work-tree'], repoDir);
  if (!check.ok || check.stdout !== 'true') {
    return { isGit: false, path: repoDir };
  }

  const [branchRes, headRes, statusRes, rootRes] = await Promise.all([
    runGit(['branch', '--show-current'], repoDir),
    runGit(['log', '-1', '--format=%H%x1f%an%x1f%s%x1f%ct'], repoDir),
    runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repoDir),
    runGit(['rev-list', '--max-parents=0', 'HEAD'], repoDir),
  ]);
  const repoId = rootRes.ok && rootRes.stdout ? rootRes.stdout.split(/\r?\n/).sort().join('-') : null;

  let lastCommit = null;
  if (headRes.ok && headRes.stdout) {
    const [hash, author, subject, time] = headRes.stdout.split('\x1f');
    lastCommit = {
      hash: hash || '',
      shortHash: (hash || '').slice(0, 7),
      author: author || '',
      message: subject || '',
      timestamp: Number(time) * 1000 || Date.now(),
    };
  }

  const modified = [];
  const staged = [];
  const untracked = [];

  if (statusRes.ok && statusRes.stdout) {
    const lines = statusRes.stdout.split('\0').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const x = line[0];
      const y = line[1];
      const filePath = line.slice(3);
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;

      if (x === '?' && y === '?') {
        untracked.push(filePath);
      } else {
        if (x !== ' ' && x !== '?') staged.push(filePath);
        if (y !== ' ' && y !== '?') modified.push(filePath);
      }
    }
  }

  return {
    isGit: true,
    path: repoDir,
    repoId,
    branch: branchRes.stdout || 'HEAD',
    lastCommit,
    clean: modified.length === 0 && staged.length === 0 && untracked.length === 0,
    modified,
    staged,
    untracked,
    totalChanges: new Set([...modified, ...staged, ...untracked]).size,
    ...await getDiff(repoDir).then(diff => ({ additions: diff.totalAdditions, deletions: diff.totalDeletions })), 
  };
}

/**
 * Stages safe files and commits with an audit check.
 */
export async function stageAndCommit(repoDir, { message, files = [], stageAll = false } = {}) {
  const current = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoDir);
  if (!current.ok) throw new Error('Detached HEAD: select a working branch before committing');
  if ((await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], repoDir)).ok) throw new Error('Complete or abort the active merge before committing');
  if (!message || typeof message !== 'string' || !message.trim()) {
    throw new Error('Commit message is required');
  }

  // If specific files given, audit and stage them
  if (files.length > 0) {
    const audit = auditChangeset(files);
    if (!audit.safe) {
      throw new Error(`Security Shield blocked commit: ${audit.rejectedFiles.map((f) => `${f.file} (${f.reason})`).join(', ')}`);
    }
    const addRes = await runGit(['add', '--', ...audit.approvedFiles], repoDir);
    if (!addRes.ok) throw new Error(addRes.stderr || 'Git add failed');
  } else {
    const status = await getRepoStatus(repoDir);
    // Respect explicit staging: only auto-stage unstaged/untracked files when nothing is staged yet or stageAll is requested
    if (stageAll || status.staged.length === 0) {
      const candidateFiles = [...status.modified, ...status.untracked];
      const audit = auditChangeset(candidateFiles);
      if (!audit.safe) {
        throw new Error(`Security Shield blocked files: ${audit.rejectedFiles.map((f) => `${f.file} (${f.reason})`).join(', ')}`);
      }
      if (audit.approvedFiles.length === 0 && status.staged.length === 0) {
        throw new Error('No changed files to commit');
      }
      if (audit.approvedFiles.length > 0) {
        const addRes = await runGit(['add', '--', ...audit.approvedFiles], repoDir);
        if (!addRes.ok) throw new Error(addRes.stderr || 'Git add failed');
      }
    }
  }

  const stagedNames = await runGit(['diff', '--cached', '--name-only', '-z'], repoDir);
  const stagedDiff = await runGit(['diff', '--cached'], repoDir);
  if (!stagedNames.ok || !stagedDiff.ok) throw new Error('Cannot audit staged changes');
  const stagedAudit = auditChangeset(stagedNames.stdout.split('\0').filter(Boolean), stagedDiff.stdout);
  if (!stagedAudit.safe) throw new Error('Security Shield blocked staged changes');
  const commitRes = await runGit(['commit', '-m', message], repoDir);
  if (!commitRes.ok) {
    throw new Error(commitRes.stderr || 'Git commit failed');
  }

  const head = await runGit(['rev-parse', 'HEAD'], repoDir);
  return {
    ok: true,
    hash: head.stdout,
    shortHash: head.stdout.slice(0, 7),
    message,
  };
}

/**
 * Returns structured diff and security audit against HEAD or peer ref.
 */
export function validateGitRef(ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9/_-]*(?:\.[A-Za-z0-9/_-]+)*$/.test(ref)
      || ref.includes('//') || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) throw new Error('Invalid Git ref');
  return ref;
}

export function repoBranchKey(repoId) {
  if (typeof repoId !== 'string' || !/^[a-f0-9]{40}(?:-[a-f0-9]{40})*$/.test(repoId)) return '';
  return repoId.slice(0, 12);
}

export function collabBranch(username, repoId = '') {
  if (typeof username !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(username)) throw new Error('Invalid collaboration username');
  const key = repoBranchKey(repoId);
  return key ? `collab/${key}/${username.toLowerCase()}` : `collab/${username.toLowerCase()}`;
}

export async function commitOnCollabBranch(repoDir, username, message) {
  const branch = collabBranch(username);
  const current = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoDir);
  if (!current.ok) throw new Error('Detached HEAD: select a working branch before committing');
  const conflicts = await getMergeConflicts(repoDir);
  if (conflicts.count) throw new Error('Resolve the active merge before committing');
  const merging = await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], repoDir);
  if (merging.ok) throw new Error('Complete or abort the active merge before committing');
  if (current.stdout !== branch) {
    const existing = await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoDir);
    if (existing.ok) throw new Error(`Branch ${branch} already exists; switch explicitly before committing`);
    const created = await runGit(['switch', '-c', branch], repoDir);
    if (!created.ok) throw new Error(created.stderr || 'Could not create collaboration branch');
  }
  // Never reset, overwrite an existing branch, stash, or discard caller work.
  return { ...await stageAndCommit(repoDir, { message }), branch, previousBranch: current.stdout };
}

export async function getRepoMetadata(repoDir) {
  const status = await getRepoStatus(repoDir);
  if (!status.isGit) throw new Error('repoDir must identify a Git working repository');
  const diff = status.lastCommit ? await getDiff(repoDir) : null;
  return { repoName: path.basename(path.resolve(repoDir)), branch: status.branch,
    commitHash: status.lastCommit?.hash || null,
    diffSummary: { files: diff?.files.length || 0, additions: diff?.totalAdditions || 0,
      deletions: diff?.totalDeletions || 0, untracked: status.untracked.length }, path: path.resolve(repoDir) };
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_PREVIEW = 256 * 1024;
const MAX_PREVIEW_FILES = 200;

// Peer comparisons are commit-to-commit, never peer-to-dirty-worktree.
export async function getDiff(repoDir, targetRef = 'HEAD', { committed = false } = {}) {
  validateGitRef(targetRef);
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], repoDir);
  const base = head.ok ? 'HEAD' : EMPTY_TREE;
  const peer = targetRef !== 'HEAD';
  const parent = committed ? await runGit(['rev-parse', '--verify', 'HEAD^'], repoDir) : null;
  const refs = peer ? [base, targetRef] : committed ? [parent.ok ? parent.stdout : EMPTY_TREE, 'HEAD'] : [base];
  const names = await runGit(['diff', '--no-renames', '--name-only', '-z', ...refs, '--'], repoDir);
  if (!names.ok) throw new Error(names.stderr || 'Git diff failed');
  const tracked = names.stdout.split('\0').filter(Boolean);
  const untrackedRes = !peer && !committed ? await runGit(['ls-files', '--others', '--exclude-standard', '-z'], repoDir) : { stdout: '' };
  const untracked = new Set(untrackedRes.stdout.split('\0').filter(Boolean));
  const all = [...new Set([...tracked, ...untracked])];
  const files = [];
  let remaining = MAX_PREVIEW;
  for (const file of all.slice(0, MAX_PREVIEW_FILES)) {
    let patch = '', additions = 0, deletions = 0, omitted = false;
    if (untracked.has(file)) {
      const inspection = inspectFilePath(file);
      const root = await fs.realpath(repoDir);
      const absolute = path.resolve(root, file);
      const stat = await fs.lstat(absolute);
      // Never follow untracked symlinks, read secrets, or allocate arbitrarily large buffers.
      const real = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? await fs.realpath(absolute) : '';
      if (!inspection.allowed || !real.startsWith(root + path.sep) || stat.size > remaining || !stat.isFile()) omitted = true;
      else {
        const bytes = await fs.readFile(absolute);
        if (bytes.includes(0)) omitted = true;
        else {
          const text = bytes.toString('utf8');
          const lines = text ? text.replace(/\n$/, '').split('\n') : [];
          additions = lines.length;
          patch = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}`;
        }
      }
    } else {
      const stat = await runGit(['diff', '--no-ext-diff', '--no-textconv', '--numstat', ...refs, '--', file], repoDir);
      const [add, del] = stat.stdout.split('\t');
      additions = Number(add) || 0; deletions = Number(del) || 0;
      const result = await runGit(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...refs, '--', file], repoDir);
      if (!result.ok) throw new Error('Git patch exceeds safe preview limits or failed');
      patch = result.stdout;
    }
    if (Buffer.byteLength(patch) > remaining) { patch = ''; omitted = true; }
    remaining -= Buffer.byteLength(patch);
    files.push({ file, additions, deletions, patch, diffText: patch, omitted, untracked: untracked.has(file) });
  }
  const diffText = files.map(file => file.patch).filter(Boolean).join('\n');
  return { ok: true, targetRef, diffText, files, totalChanges: all.length, truncated: all.length > files.length || files.some(f => f.omitted),
    totalAdditions: files.reduce((n, f) => n + f.additions, 0), totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
    audit: auditChangeset(all, diffText) };
}

/**
 * Builds the remote vault URL with authenticated token in-memory only.
 */
function buildVaultGitUrl(token, vaultOwner, vaultRepo) {
  if (!token || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(vaultOwner || '') || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(vaultRepo || '') || vaultRepo.includes('..')) throw new Error('Authenticated Vault coordinates required');
  return `https://github.com/${vaultOwner}/${vaultRepo}.git`;
}

export function redactGitError(message, token = '') {
  let text = String(message || 'Native Git operation failed');
  for (const secret of [token, encodeURIComponent(token), Buffer.from(`x-access-token:${token}`).toString('base64')].filter(Boolean)) text = text.split(secret).join('***');
  return text.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://***@').replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '***');
}

// Credentials exist only in the subprocess environment, not argv, remotes, or files.
async function vaultGit(args, repoDir, options) {
  buildVaultGitUrl(options.token, options.vaultOwner, options.vaultRepo);
  const result = await runGit(args, repoDir, {
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${options.token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GCM_INTERACTIVE: 'Never',
  });
  if (!result.ok) throw new Error(redactGitError(result.stderr || result.message, options.token));
  return result;
}

export async function getRepositoryIdentity(repoDir, ref = 'HEAD') {
  validateGitRef(ref);
  const roots = await runGit(['rev-list', '--max-parents=0', ref], repoDir);
  if (!roots.ok || !roots.stdout) throw new Error('Commit HEAD before sharing or syncing');
  return roots.stdout.split(/\r?\n/).sort().join('-');
}

function cardBranch(options) {
  const legacy = collabBranch(options.peerUsername);
  if (options.repoId && !/^[a-f0-9]{40}(?:-[a-f0-9]{40})*$/.test(options.repoId)) throw new Error('Invalid repository identity');
  if (options.hash && !/^[a-f0-9]{40}$/.test(options.hash)) throw new Error('Invalid card commit hash');
  const scoped = options.repoId ? collabBranch(options.peerUsername, options.repoId) : null;
  if (options.branch) {
    if (options.branch === scoped || options.branch === legacy) return options.branch;
    const peerLower = String(options.peerUsername || '').toLowerCase();
    if (/^collab\/[a-f0-9]{12}\//.test(options.branch) && options.branch.endsWith(`/${peerLower}`)) {
      throw new Error('Repository identity mismatch');
    }
    throw new Error('Card branch does not match peer username');
  }
  return scoped || legacy;
}

async function validateCard(repoDir, ref, options) {
  if (options.repoId && await getRepositoryIdentity(repoDir, ref) !== options.repoId) throw new Error('Repository identity mismatch');
  const hash = await runGit(['rev-parse', ref], repoDir);
  if (options.hash && hash.stdout !== options.hash) {
    const descendant = await runGit(['merge-base', '--is-ancestor', options.hash, ref], repoDir);
    if (!descendant.ok) throw new Error('Card history no longer matches shared branch');
  }
}

/**
 * Pushes collaboration branch `collab/<repoKey12>/<my-username>` to the shared vault (multi-repo safe).
 */
export async function pushCollabBranch(repoDir, options = {}) {
  const { username, token, vaultOwner, vaultRepo } = options;
  if (!username || !token || !vaultOwner || !vaultRepo) throw new Error('Authenticated Git Vault required; local/LAN push fallback is disabled');
  const repoId = await getRepositoryIdentity(repoDir);
  if (options.repoId && options.repoId !== repoId) throw new Error('Repository identity mismatch');
  const branchName = collabBranch(username, repoId);
  const tree = await runGit(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], repoDir);
  const content = await runGit(['log', '--format=', '-p', '--no-ext-diff', '--no-textconv', 'HEAD'], repoDir);
  if (!tree.ok || !content.ok || !auditChangeset(tree.stdout.split('\0').filter(Boolean), content.stdout).safe) throw new Error('Security Shield blocked repository history');
  const remoteUrl = buildVaultGitUrl(token, vaultOwner, vaultRepo);
  const remote = await vaultGit(['ls-remote', '--heads', remoteUrl, `refs/heads/${branchName}`], repoDir, options);
  if (remote.stdout) {
    const remoteHash = remote.stdout.split(/\s/)[0];
    await vaultGit(['fetch', '--no-tags', remoteUrl, `refs/heads/${branchName}`], repoDir, options);
    if (await getRepositoryIdentity(repoDir, remoteHash) !== repoId) throw new Error('Vault collaboration branch belongs to an unrelated repository; use a separate Vault repository');
    if (!(await runGit(['merge-base', '--is-ancestor', remoteHash, 'HEAD'], repoDir)).ok) throw new Error('Vault collaboration branch is ahead or diverged; fetch and merge explicitly before pushing');
  }
  await vaultGit(['push', remoteUrl, `HEAD:refs/heads/${branchName}`], repoDir, options);
  const head = await runGit(['rev-parse', 'HEAD'], repoDir);
  return { ok: true, branch: branchName, hash: head.stdout, shortHash: head.stdout.slice(0, 7), repoId, vaultOwner, vaultRepo, transport: 'git-vault' };
}

export async function syncGitRepository(repoDir, options) {
  const remoteUrl = buildVaultGitUrl(options.token, options.vaultOwner, options.vaultRepo);
  const repoId = await getRepositoryIdentity(repoDir);
  const key = repoBranchKey(repoId);
  await vaultGit(['fetch', '--no-tags', remoteUrl, `+refs/heads/collab/${key}/*:refs/remotes/work-vault/collab/${key}/*`], repoDir, options);
  return { ...await pushCollabBranch(repoDir, options), fetched: true };
}

export async function cloneSharedRepository(parentDir, repoName, options) {
  if (typeof parentDir !== 'string' || !path.isAbsolute(parentDir) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName || '') || repoName.includes('..') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(repoName)) throw new Error('Valid parent directory and repository name required');
  if (!options.repoId) throw new Error('Shared repository identity required');
  const branch = cardBranch(options);
  const remoteUrl = buildVaultGitUrl(options.token, options.vaultOwner, options.vaultRepo);
  const stat = await fs.lstat(parentDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Parent must be a real directory');
  const parent = await fs.realpath(parentDir);
  const target = path.join(parent, repoName);
  await fs.mkdir(target);
  try {
    await vaultGit(['clone', '--no-checkout', '--single-branch', '--branch', branch, '--', remoteUrl, target], parent, options);
    await validateCard(target, 'HEAD', options);
    const tree = await runGit(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], target);
    const preview = await getDiff(target, 'HEAD', { committed: true });
    if (!tree.ok || !auditChangeset(tree.stdout.split('\0').filter(Boolean), preview.diffText).safe) throw new Error('Security Shield blocked shared repository');
    await vaultGit(['checkout', branch], target, options);
    return { ok: true, path: target, repoPath: target, repoName, repoId: options.repoId, branch, transport: 'git-vault' };
  } catch (error) {
    // This target was exclusively reserved above; existing directories are never removed.
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Fetches peer collaboration branch `collab/<peer-username>` from the shared vault into a local ref.
 */
export async function fetchCollabBranch(repoDir, options = {}) {
  const { username, token, vaultOwner, vaultRepo, peerUsername } = options;
  if (!username || !token || !vaultOwner || !vaultRepo || !peerUsername) {
    throw new Error('Missing parameters for peer collab fetch');
  }

  const remoteUrl = buildVaultGitUrl(token, vaultOwner, vaultRepo);
  const peerBranch = cardBranch(options);
  const localRef = `refs/remotes/work-vault/${vaultOwner}/${vaultRepo}/${peerBranch}`;
  await vaultGit(['fetch', '--no-tags', remoteUrl, `+refs/heads/${peerBranch}:${localRef}`], repoDir, options);
  await validateCard(repoDir, localRef, options);

  // Get commit summary of peer branch
  const logRes = await runGit(['log', '-1', '--format=%H%x1f%an%x1f%s%x1f%ct', localRef], repoDir);
  let peerCommit = null;
  if (logRes.ok && logRes.stdout) {
    const [hash, author, subject, time] = logRes.stdout.split('\x1f');
    peerCommit = {
      hash,
      shortHash: hash.slice(0, 7),
      author,
      message: subject,
      timestamp: Number(time) * 1000 || Date.now(),
    };
  }

  // Diff between local HEAD and peer ref
  const diffInfo = await getDiff(repoDir, localRef);

  return {
    ok: true,
    peerBranch,
    localRef,
    peerCommit,
    diff: diffInfo,
  };
}

/**
 * Merges the fetched peer collaboration branch into local working branch.
 */
export async function mergeCollabBranch(repoDir, peerUsername, options = null) {
  collabBranch(peerUsername);
  const localRef = options ? (await fetchCollabBranch(repoDir, { ...options, peerUsername })).localRef : `refs/remotes/${collabBranch(peerUsername)}`;
  const diff = await getDiff(repoDir, localRef);
  if (!diff.audit.safe) throw new Error('Security Shield blocked peer merge');
  const status = await getRepoStatus(repoDir);
  if (!status.clean) throw new Error('Commit or preserve local changes before merging');
  const mergeRes = await runGit(['merge', localRef, '-m', `Collab merge from @${peerUsername}`], repoDir);

  if (!mergeRes.ok) {
    const isConflict = mergeRes.stderr.includes('CONFLICT') || mergeRes.stdout.includes('CONFLICT');
    if (isConflict) {
      return {
        ok: false,
        conflict: true,
        message: 'Merge conflict detected. Please resolve conflicts or inspect diff.',
        raw: mergeRes.stdout || mergeRes.stderr,
      };
    }
    throw new Error(mergeRes.stderr || 'Git merge failed');
  }

  const head = await runGit(['rev-parse', 'HEAD'], repoDir);
  return {
    ok: true,
    mergedRef: localRef,
    newHash: head.stdout,
    shortHash: head.stdout.slice(0, 7),
  };
}


/**
 * Lists conflicted files and extracts base / ours / theirs / working versions for 3-way resolution.
 */
export async function getMergeConflicts(repoDir) {
  const unmergedRes = await runGit(['diff', '--name-only', '--diff-filter=U'], repoDir);
  if (!unmergedRes.ok) {
    throw new Error(unmergedRes.stderr || 'Failed to inspect merge conflicts');
  }
  const files = unmergedRes.stdout ? unmergedRes.stdout.split(/\r?\n/).filter(Boolean) : [];
  const conflicts = [];

  for (const relPath of files) {
    const [baseRes, oursRes, theirsRes] = await Promise.all([
      runGit(['show', `:1:${relPath}`], repoDir),
      runGit(['show', `:2:${relPath}`], repoDir),
      runGit(['show', `:3:${relPath}`], repoDir),
    ]);
    let working = '';
    try {
      working = await fs.readFile(path.join(repoDir, relPath), 'utf8');
    } catch {}
    conflicts.push({
      file: relPath,
      base: baseRes.ok ? baseRes.stdout : '',
      ours: oursRes.ok ? oursRes.stdout : '',
      theirs: theirsRes.ok ? theirsRes.stdout : '',
      working,
    });
  }

  return { ok: true, count: conflicts.length, conflicts };
}

/**
 * Resolves a single conflicted file using 'ours', 'theirs', or 'manual' content and stages it.
 */
export async function resolveMergeConflict(repoDir, { filePath, strategy = 'ours', manualContent = null } = {}) {
  const inspection = inspectFilePath(filePath);
  if (!inspection.allowed) {
    throw new Error(`Security Shield blocked conflict resolution: ${inspection.reason}`);
  }

  if (strategy === 'ours' || strategy === 'theirs') {
    const checkoutFlag = strategy === 'ours' ? '--ours' : '--theirs';
    const coRes = await runGit(['checkout', checkoutFlag, '--', filePath], repoDir);
    if (!coRes.ok) throw new Error(coRes.stderr || `Failed to accept ${strategy}`);
  } else if (strategy === 'manual') {
    if (typeof manualContent !== 'string') {
      throw new Error('Manual resolution requires content');
    }
    const target = path.resolve(repoDir, filePath);
    if (!target.startsWith(path.resolve(repoDir) + path.sep)) {
      throw new Error('Path traversal blocked');
    }
    await fs.writeFile(target, manualContent, 'utf8');
  } else {
    throw new Error(`Unknown conflict resolution strategy: ${strategy}`);
  }

  const addRes = await runGit(['add', '--', filePath], repoDir);
  if (!addRes.ok) throw new Error(addRes.stderr || 'Failed to stage resolved file');

  const remaining = await getMergeConflicts(repoDir);
  return { ok: true, filePath, strategy, remainingCount: remaining.count };
}

/**
 * Completes an active merge once all conflicts are resolved.
 */
export async function completeMerge(repoDir, message = 'Resolved collaboration merge') {
  const remaining = await getMergeConflicts(repoDir);
  if (remaining.count > 0) {
    throw new Error(`${remaining.count} conflicted file(s) still unresolved`);
  }
  const commitRes = await runGit(['commit', '-m', message], repoDir);
  if (!commitRes.ok) throw new Error(commitRes.stderr || 'Failed to complete merge commit');
  const head = await runGit(['rev-parse', 'HEAD'], repoDir);
  return { ok: true, hash: head.stdout, shortHash: head.stdout.slice(0, 7) };
}

/**
 * Safely aborts an in-progress merge without corrupting the workspace.
 */
export async function abortMerge(repoDir) {
  const res = await runGit(['merge', '--abort'], repoDir);
  if (!res.ok) throw new Error(res.stderr || 'No active merge to abort');
  return { ok: true, aborted: true };
}

export function parseGithubRemote(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const clean = remoteUrl.trim().replace(/\.git$/i, '');
  const m = clean.match(/(?:github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2], htmlUrl: `https://github.com/${m[1]}/${m[2]}` };
}

export async function getWorkspaceGitOverview(repoDir) {
  const status = await getRepoStatus(repoDir);
  if (!status.isGit) return { isGit: false };
  const [remoteRes, branchesRes, abRes] = await Promise.all([
    runGit(['remote', 'get-url', 'origin'], repoDir),
    runGit(['branch', '--format=%(refname:short)'], repoDir),
    runGit(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], repoDir),
  ]);
  const remoteUrl = remoteRes.ok ? remoteRes.stdout.trim() : '';
  const githubRemote = parseGithubRemote(remoteUrl);
  const branches = branchesRes.ok ? branchesRes.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
  let behind = 0;
  let ahead = 0;
  if (abRes.ok && abRes.stdout) {
    const parts = abRes.stdout.trim().split(/\s+/);
    behind = Number(parts[0]) || 0;
    ahead = Number(parts[1]) || 0;
  }
  return { ...status, remoteUrl, githubRemote, branches, ahead, behind };
}

export async function stageGitFiles(repoDir, files = []) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return { ok: true, staged: 0 };
  const audit = auditChangeset(list);
  if (!audit.safe) throw new Error(`Security Shield blocked staging: ${audit.rejectedFiles.map(f => f.file).join(', ')}`);
  const res = await runGit(['add', '--', ...audit.approvedFiles], repoDir);
  if (!res.ok) throw new Error(res.stderr || 'Git add failed');
  return { ok: true, staged: audit.approvedFiles.length };
}

export async function unstageGitFiles(repoDir, files = []) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return { ok: true, unstaged: 0 };
  for (const f of list) {
    if (!inspectFilePath(f).allowed) throw new Error('Invalid file path');
  }
  const hasHead = (await runGit(['rev-parse', '--verify', 'HEAD'], repoDir)).ok;
  const res = hasHead
    ? await runGit(['reset', 'HEAD', '--', ...list], repoDir)
    : await runGit(['rm', '--cached', '-q', '--', ...list], repoDir);
  if (!res.ok) throw new Error(res.stderr || 'Git unstage failed');
  return { ok: true, unstaged: list.length };
}

export async function discardFileChanges(repoDir, filePath) {
  if (!filePath || !inspectFilePath(filePath).allowed) throw new Error('Invalid file path');
  const root = await fs.realpath(repoDir);
  const abs = path.resolve(root, filePath);
  if (!abs.startsWith(root + path.sep)) throw new Error('Path traversal blocked');
  const tracked = await runGit(['ls-files', '--error-unmatch', '--', filePath], repoDir);
  if (tracked.ok) {
    const res = await runGit(['checkout', '--', filePath], repoDir);
    if (!res.ok) throw new Error(res.stderr || 'Discard tracked changes failed');
  } else {
    await fs.rm(abs, { recursive: true, force: true });
  }
  return { ok: true, discarded: filePath };
}

export async function switchGitBranch(repoDir, branchName, { create = false } = {}) {
  const branch = validateGitRef(branchName);
  const res = create
    ? await runGit(['switch', '-c', branch], repoDir)
    : await runGit(['switch', branch], repoDir);
  if (!res.ok) throw new Error(res.stderr || `Could not switch to ${branch}`);
  return { ok: true, branch };
}

export async function pushOriginBranch(repoDir, { token, owner, repo, remoteUrl, branch } = {}) {
  if (!token) throw new Error('GitHub PAT required');
  const current = branch ? validateGitRef(branch) : (await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repoDir)).stdout;
  if (!current) throw new Error('Select a branch before pushing');
  let targetUrl = remoteUrl;
  if (!targetUrl && owner && repo) targetUrl = `https://github.com/${owner}/${repo}.git`;
  if (!targetUrl) {
    const existing = await runGit(['remote', 'get-url', 'origin'], repoDir);
    if (!existing.ok || !existing.stdout) throw new Error('No origin remote configured');
    targetUrl = existing.stdout.trim();
  }
  if (targetUrl.startsWith('https://github.com/')) {
    const parsed = parseGithubRemote(targetUrl);
    if (parsed) await vaultGit(['push', '-u', targetUrl, `HEAD:refs/heads/${current}`], repoDir, { token, vaultOwner: parsed.owner, vaultRepo: parsed.repo });
    else {
      const res = await runGit(['push', '-u', targetUrl, `HEAD:refs/heads/${current}`], repoDir);
      if (!res.ok) throw new Error(redactGitError(res.stderr || res.message, token));
    }
  } else {
    const res = await runGit(['push', '-u', 'origin', `HEAD:refs/heads/${current}`], repoDir);
    if (!res.ok) throw new Error(redactGitError(res.stderr || res.message, token));
  }
  return { ok: true, branch: current, remoteUrl: targetUrl, githubRemote: parseGithubRemote(targetUrl) };
}

export async function ensureOriginRemote(repoDir, remoteUrl) {
  const existing = await runGit(['remote', 'get-url', 'origin'], repoDir);
  if (existing.ok && existing.stdout) {
    await runGit(['remote', 'set-url', 'origin', remoteUrl], repoDir);
  } else {
    const addRes = await runGit(['remote', 'add', 'origin', remoteUrl], repoDir);
    if (!addRes.ok) throw new Error(addRes.stderr || 'Failed to add origin remote');
  }
  return { ok: true, remoteUrl };
}
