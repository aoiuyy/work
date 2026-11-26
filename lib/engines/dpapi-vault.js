import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_INPUT = 16 * 1024;
const MAX_OUTPUT = 32 * 1024;
const ENTROPY = 'DSH-Work token v1';

const SCRIPT = String.raw`
$ErrorActionPreference='Stop';
$ProgressPreference='SilentlyContinue';
Add-Type -AssemblyName System.Security;
$raw=[Console]::In.ReadToEnd();
if($raw.Length -gt 16384){throw 'input too large'};
$x=$raw|ConvertFrom-Json;
$entropy=[Text.Encoding]::UTF8.GetBytes('DSH-Work token v1');
$base=[Environment]::GetFolderPath('LocalApplicationData');
if($x.vaultDir){$dir=[string]$x.vaultDir}elseif($env:DSH_WORK_VAULT_DIR){$dir=$env:DSH_WORK_VAULT_DIR}else{$dir=Join-Path $base 'DSH-Work'};
$fileName = if($x.fileName){[string]$x.fileName}else{'refresh-token.dpapi'};
if($fileName -match '[\\/:]'){throw 'invalid fileName'};
$file=Join-Path $dir $fileName;
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;

function LockPath($p,$directory){
  $acl=if($directory){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};
  $acl.SetAccessRuleProtection($true,$false);
  foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($r)};
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$(if($directory){'ContainerInherit,ObjectInherit'}else{'None'}),'None','Allow');
  $acl.AddAccessRule($rule);
  if($directory){[IO.Directory]::SetAccessControl($p,$acl)}else{[IO.File]::SetAccessControl($p,$acl)}
};

if($x.op -eq 'write'){
  [IO.Directory]::CreateDirectory($dir)|Out-Null;
  LockPath $dir $true;
  $plain=[Convert]::FromBase64String($x.value);
  if($plain.Length -gt 8192){throw 'token too large'};
  $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
  $tmp=Join-Path $dir ('.token-'+[Guid]::NewGuid().ToString('N')+'.tmp');
  $backup=Join-Path $dir ('.token-'+[Guid]::NewGuid().ToString('N')+'.bak');
  try{
    [IO.File]::WriteAllBytes($tmp,$cipher);
    LockPath $tmp $false;
    if([IO.File]::Exists($file)){
      LockPath $file $false;
      try{[IO.File]::Replace($tmp,$file,$backup)}catch{if(-not [IO.File]::Exists($file) -and [IO.File]::Exists($backup)){LockPath $backup $false; [IO.File]::Move($backup,$file)}; throw};
      LockPath $backup $false;
      [IO.File]::Delete($backup)
    }else{
      [IO.File]::Move($tmp,$file)
    }
  }finally{
    if([IO.File]::Exists($tmp)){[IO.File]::Delete($tmp)}
  };
  [Console]::Out.Write('ok')
} elseif($x.op -eq 'read'){
  if(-not [IO.File]::Exists($file)){
    [Console]::Out.Write('null')
  }else{
    $c=[IO.File]::ReadAllBytes($file);
    if($c.Length -gt 16384){throw 'cipher too large'};
    $p=[Security.Cryptography.ProtectedData]::Unprotect($c,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
    [Console]::Out.Write([Convert]::ToBase64String($p))
  }
} elseif($x.op -eq 'delete'){
  if([IO.File]::Exists($file)){[IO.File]::Delete($file)};
  if([IO.Directory]::Exists($dir)){Get-ChildItem -LiteralPath $dir -Filter '.token-*.tmp' -File | Remove-Item -Force};
  [Console]::Out.Write('ok')
} else{
  throw 'invalid operation'
}`;

function getVaultDir(options = {}) {
  const value = options.vaultDir !== undefined ? options.vaultDir : process.env.DSH_WORK_VAULT_DIR;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError('vaultDir must be a non-empty path');
  const parts = value.replace(/^[a-z]:/i, '').split(/[\\/]+/);
  if (parts.includes('..')) throw new TypeError('vaultDir must not contain path traversal');
  return path.resolve(value);
}

const readCache = new Map();
const inFlightReads = new Map();

function resolveVaultFilePath(vaultDir, fileName) {
  const dir = vaultDir || path.join(process.env.LOCALAPPDATA || '', 'DSH-Work');
  return path.join(dir, fileName);
}

function fileFingerprint(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

export function clearVaultCache() {
  readCache.clear();
  inFlightReads.clear();
}

function invoke(operation, value, options = {}) {
  const vaultDir = getVaultDir(options);
  const fileName = options.fileName || 'refresh-token.dpapi';
  const filePath = resolveVaultFilePath(vaultDir, fileName);
  const key = filePath.toLowerCase();

  if (operation === 'read') {
    const fp = fileFingerprint(filePath);
    const cached = readCache.get(key);
    if (cached && cached.fp === fp) return Promise.resolve(cached.val);
    if (inFlightReads.has(key)) return inFlightReads.get(key);
  } else {
    readCache.delete(key);
    inFlightReads.delete(key);
  }

  const input = JSON.stringify({
    op: operation,
    fileName,
    ...(value === undefined ? {} : { value: Buffer.from(value, 'utf8').toString('base64') }),
    ...(vaultDir ? { vaultDir } : {})
  });
  if (Buffer.byteLength(input) > MAX_INPUT) throw new Error('DPAPI vault input too large');
  const task = new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('DPAPI vault is only available on Windows'));
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = Buffer.alloc(0);
    child.stdout.on('data', chunk => { out = Buffer.concat([out, chunk]); if (out.length > MAX_OUTPUT) child.kill(); });
    child.on('error', () => reject(new Error('DPAPI vault operation failed')));
    child.on('close', code => {
      if (code === 0 && out.length <= MAX_OUTPUT) {
        const text = out.toString('utf8');
        const fp = fileFingerprint(filePath);
        if (operation === 'read') readCache.set(key, { fp, val: text });
        else if (operation === 'write' && value !== undefined) readCache.set(key, { fp, val: Buffer.from(value, 'utf8').toString('base64') });
        else if (operation === 'delete') readCache.set(key, { fp, val: 'null' });
        resolve(text);
      } else {
        reject(new Error('DPAPI vault operation failed'));
      }
    });
    child.stdin.end(input);
  });

  if (operation === 'read') {
    inFlightReads.set(key, task);
    task.finally(() => { if (inFlightReads.get(key) === task) inFlightReads.delete(key); }).catch(() => {});
  }
  return task;
}

// Supabase Refresh Token
export async function readToken(options = {}) {
  const result = await invoke('read', undefined, { ...options, fileName: 'refresh-token.dpapi' });
  if (result === 'null') return null;
  try { return Buffer.from(result, 'base64').toString('utf8'); } catch { throw new Error('DPAPI vault operation failed'); }
}
export async function writeToken(token, options = {}) {
  if (typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > 8192) throw new TypeError('token must be a non-empty string no larger than 8192 bytes');
  await invoke('write', token, { ...options, fileName: 'refresh-token.dpapi' });
}
export async function deleteToken(options = {}) {
  await invoke('delete', undefined, { ...options, fileName: 'refresh-token.dpapi' });
}

// GitHub Auth (JSON: { username, token })
export async function readGithubAuth(options = {}) {
  const result = await invoke('read', undefined, { ...options, fileName: 'github-auth.dpapi' });
  if (result === 'null') return null;
  try {
    const raw = Buffer.from(result, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export async function writeGithubAuth(authData, options = {}) {
  const serialized = typeof authData === 'string' ? authData : JSON.stringify(authData);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 8192) throw new TypeError('authData must be valid');
  await invoke('write', serialized, { ...options, fileName: 'github-auth.dpapi' });
}
export async function deleteGithubAuth(options = {}) {
  await invoke('delete', undefined, { ...options, fileName: 'github-auth.dpapi' });
}

// Machine Profile (JSON: { machineId, machineName, machineToken })
export async function readMachineProfile(options = {}) {
  const result = await invoke('read', undefined, { ...options, fileName: 'machine-profile.dpapi' });
  if (result === 'null') return null;
  try {
    const raw = Buffer.from(result, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export async function writeMachineProfile(profileData, options = {}) {
  const serialized = typeof profileData === 'string' ? profileData : JSON.stringify(profileData);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 8192) throw new TypeError('profileData must be valid');
  await invoke('write', serialized, { ...options, fileName: 'machine-profile.dpapi' });
}

// Linked Peer Machines with Friendly Aliases (JSON Array: [{ peerToken, alias, linkedAt }])
export async function readPeerLinks(options = {}) {
  const result = await invoke('read', undefined, { ...options, fileName: 'peer-links.dpapi' });
  if (result === 'null') return [];
  try {
    const raw = Buffer.from(result, 'base64').toString('utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function writePeerLinks(links, options = {}) {
  const serialized = JSON.stringify(Array.isArray(links) ? links : []);
  if (Buffer.byteLength(serialized, 'utf8') > 8192) throw new TypeError('links list too large');
  await invoke('write', serialized, { ...options, fileName: 'peer-links.dpapi' });
}

// Persistent Work Config (JSON: { vaultRepo, defaultParent, machineName })
export async function readWorkConfig(options = {}) {
  const result = await invoke('read', undefined, { ...options, fileName: 'work-config.dpapi' });
  if (result === 'null') return null;
  try {
    const raw = Buffer.from(result, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeWorkConfig(configData, options = {}) {
  const serialized = typeof configData === 'string' ? configData : JSON.stringify(configData);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 8192) throw new TypeError('configData must be valid');
  await invoke('write', serialized, { ...options, fileName: 'work-config.dpapi' });
}


