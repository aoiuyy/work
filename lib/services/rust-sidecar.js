import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Stdio JSON-RPC client for the optional Rust work-daemon sidecar.
 */
export class RustSidecarManager {
  constructor(pluginDir) {
    this.pluginDir = pluginDir;
    this.process = null;
    this.seq = 0;
    this.pending = new Map();
    this.isAlive = false;
  }

  getExecutablePath() {
    const exeName = process.platform === 'win32' ? 'work-daemon.exe' : 'work-daemon';
    const candidates = [
      path.join(this.pluginDir, 'bin', exeName),
      path.join(this.pluginDir, 'crates', 'work-daemon', 'target', 'release', exeName),
      path.join(this.pluginDir, 'crates', 'work-daemon', 'target', 'debug', exeName),
    ];
    return candidates.find((c) => existsSync(c)) || null;
  }

  async start({ machineToken, machineName, httpPort = 0 } = {}) {
    if (this.isAlive) return true;
    const exePath = this.getExecutablePath();
    if (!exePath) {
      console.log('[Work Rust Sidecar] Binary not found, operating in JavaScript fallback mode');
      return false;
    }
    try {
      this.process = spawn(exePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          WORK_MACHINE_TOKEN: machineToken || 'WK-RUST-NODE',
          WORK_MACHINE_NAME: machineName || 'Workstation',
          WORK_HTTP_PORT: String(httpPort || 0),
        },
      });
      this.isAlive = true;

      let buffer = '';
      this.process.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const res = JSON.parse(line);
            if (res.id != null && this.pending.has(res.id)) {
              const { resolve, timer } = this.pending.get(res.id);
              clearTimeout(timer);
              this.pending.delete(res.id);
              resolve(res.error ? null : res.result);
            }
          } catch {}
        }
      });

      this.process.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) console.warn('[Work Rust Sidecar stderr]', msg);
      });

      const cleanup = () => {
        this.isAlive = false;
        this.process = null;
        for (const { resolve, timer } of this.pending.values()) {
          clearTimeout(timer);
          resolve(null);
        }
        this.pending.clear();
      };

      this.process.on('error', cleanup);
      this.process.on('exit', cleanup);

      const pong = await this.call('ping', {}, 2000);
      if (pong?.pong) {
        console.log('[Work Rust Sidecar] Connected via Stdio JSON-RPC');
        return true;
      }
      return false;
    } catch (e) {
      this.isAlive = false;
      console.warn('[Work Rust Sidecar] Spawn error:', e.message);
      return false;
    }
  }

  async call(method, params = {}, timeoutMs = 2500) {
    if (!this.isAlive || !this.process) return null;
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      }
    });
  }

  async stop() {
    if (this.process) {
      try { this.process.kill(); } catch {}
      this.process = null;
      this.isAlive = false;
    }
  }
}
