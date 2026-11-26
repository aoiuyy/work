import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Opens a native Windows folder or file dialog via STA PowerShell.
 */
export async function pickNativePathWindows({ mode = 'folder', title = 'Select Folder' } = {}) {
  const cleanTitle = (title || 'Select Path').replace(/'/g, "''");
  const psScript = mode === 'folder'
    ? `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = '${cleanTitle}'; $f.ShowNewFolderButton = $true; $dummy = New-Object System.Windows.Forms.Form; $dummy.TopMost = $true; if ($f.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }`
    : `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.OpenFileDialog; $f.Title = '${cleanTitle}'; $f.Filter = 'All Files (*.*)|*.*|Archives (*.zip;*.tar.gz)|*.zip;*.tar.gz'; $dummy = New-Object System.Windows.Forms.Form; $dummy.TopMost = $true; if ($f.ShowDialog($dummy) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.FileName) }`;

  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', b64], {
      timeout: 120000,
      windowsHide: true,
    });
    return stdout ? stdout.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Runs one-off or background dev commands and tracks spawned PIDs.
 */
export function createQuickRunner() {
  const activeManagedProcesses = new Map();

  async function runQuickCommand({ cwd, command, daemon = false } = {}) {
    if (!cwd || !command) return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'cwd and command required' } };

    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];
    const isDevServer = daemon || /dev|start|serve|vite|next|watch|python\s+-m\s+http/i.test(command);

    const child = spawn(shell, shellArgs, { cwd, shell: false });
    let output = '';

    child.stdout?.on('data', d => { output = (output + d.toString()).slice(-4000); });
    child.stderr?.on('data', d => { output = (output + d.toString()).slice(-4000); });

    if (isDevServer) {
      activeManagedProcesses.set(child.pid, { child, output, startTime: Date.now() });
      await new Promise(r => setTimeout(r, 1200));
      return {
        ok: true,
        value: {
          pid: child.pid,
          running: true,
          output: output || 'Dev server started in background.',
        },
      };
    }

    return new Promise(resolve => {
      child.on('close', code => {
        resolve({ ok: code === 0, value: { code, output: output.slice(-2000) } });
      });
      child.on('error', err => {
        resolve({ ok: false, error: { code: 'EXEC_ERROR', message: err.message } });
      });
    });
  }

  function stopQuickCommand({ pid } = {}) {
    const proc = activeManagedProcesses.get(pid);
    if (proc && proc.child) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
        } else {
          proc.child.kill('SIGTERM');
        }
      } catch {}
      activeManagedProcesses.delete(pid);
      return { ok: true, value: { stopped: true } };
    }
    return { ok: true, value: { stopped: false } };
  }

  return { runQuickCommand, stopQuickCommand };
}
