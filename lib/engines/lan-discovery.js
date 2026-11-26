// LAN Discovery & Direct P2P Transfer Engine for @local/work-v2
// High-Speed Local Wi-Fi Mesh: UDP Beacon, 6-Digit PIN Pairing, Direct HTTP Repo Stream
// 100% Handcrafted Hallmark & Impeccable Implementation

import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { validateRoomId, dmParticipants } from './chat-command.js';
import { extractZipSafely } from './zip-extractor.js';

const BROADCAST_PORT = 41234;
const BROADCAST_ADDR = '255.255.255.255';
const BEACON_INTERVAL = 2500;
const PEER_TIMEOUT = 7000;

/**
 * Get prioritized physical network interfaces, filtering APIPA and VPNs.
 */
export function getNetworkCandidates() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, netList] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();
    const isVirtual = /vpn|proton|tailscale|zerotier|docker|veth|vmnet|virtualbox|wsl|loopback/i.test(lowerName);

    for (const net of netList || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // APIPA link-local

      let priority = 10;
      if (/wi-fi|wlan|wireless/i.test(lowerName)) priority = 100;
      else if (/ethernet|lan|eth/i.test(lowerName) && !isVirtual) priority = 80;
      else if (isVirtual) priority = 1;

      // Calculate subnet broadcast
      const parts = net.address.split('.');
      const broadcast = parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.255` : '255.255.255.255';

      candidates.push({
        name,
        address: net.address,
        netmask: net.netmask,
        broadcast,
        priority,
        isVirtual,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

/**
 * Get primary local IPv4 address
 */
export function getLocalIpAddress() {
  const candidates = getNetworkCandidates();
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

/**
 * Generate a cryptographically secure 6-digit pairing PIN
 */
export function generatePairingPin() {
  return String(crypto.randomInt(100000, 999999));
}

export class LanDiscoveryEngine {
  constructor({ machineToken, machineName, defaultParent, onPeerMessage }) {
    this.machineToken = machineToken;
    this.machineName = machineName;
    this.defaultParent = defaultParent;
    this.onPeerMessage = onPeerMessage;

    this.currentPin = generatePairingPin();
    this.pinTtl = 5 * 60 * 1000; // 5 minutes TTL
    this.pinExpiresAt = Date.now() + this.pinTtl;

    this.discoveredPeers = new Map(); // peerToken -> { token, name, ip, port, lastSeen }
    this.pairSecrets = new Map();
    this.pairedPeers = new Set(); // Set of trusted peerTokens

    this.udpSocket = null;
    this.httpServer = null;
    this.httpPort = 0;
    this.beaconTimer = null;
    this.cleanupTimer = null;
    this.localIp = getLocalIpAddress();
    this.networkCandidates = getNetworkCandidates();
  }

  /**
   * Get current engine and pairing status
   */
  getStatus() {
    return {
      running: Boolean(this.httpServer && this.udpSocket),
      localIp: this.localIp,
      httpPort: this.httpPort,
      pin: this.currentPin,
      pinExpiresAt: this.pinExpiresAt,
      pinTtl: this.pinTtl || 5 * 60 * 1000,
      pairLink: this.getPairLink(),
      interfaces: this.networkCandidates,
    };
  }

  /**
   * Get 1-click pair link
   */
  getPairLink() {
    return `work://pair?host=${this.localIp}&port=${this.httpPort}&pin=${this.currentPin}&token=${encodeURIComponent(this.machineToken)}&name=${encodeURIComponent(this.machineName)}`;
  }

  /**
   * Start LAN HTTP Server and UDP Discovery Beacon
   */
  async start() {
    await this.startHttpServer();
    await this.startUdpBeacon();

    this.cleanupTimer = setInterval(() => this.purgeStalePeers(), 3000);
    if (this.cleanupTimer?.unref) this.cleanupTimer.unref();
    return {
      localIp: this.localIp,
      httpPort: this.httpPort,
      pin: this.currentPin,
      pinExpiresAt: this.pinExpiresAt,
      pinTtl: this.pinTtl || 5 * 60 * 1000,
      pairLink: this.getPairLink(),
      interfaces: this.networkCandidates,
    };
  }

  /**
   * Stop all network listeners
   */
  async stop() {
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {}
      this.udpSocket = null;
    }

    if (this.httpServer) {
      await new Promise(resolve => this.httpServer.close(resolve));
      this.httpServer = null;
    }
  }

  /**
   * Regenerate pairing PIN
   */
  refreshPin() {
    this.currentPin = generatePairingPin();
    this.pinExpiresAt = Date.now() + (this.pinTtl || 5 * 60 * 1000);
    return this.currentPin;
  }

  /**
   * Internal HTTP Server for P2P Repo Streaming & Direct Handshake
   */
  startHttpServer() {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Machine-Token, X-Pair-Pin, X-Pair-Secret');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // 1. PIN Pair Handshake Endpoint
        if (req.method === 'POST' && url.pathname === '/p2p/pair') {
          let body = '';
          req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
          req.on('end', async () => {
            try {
              const { peerToken, peerName, pin, port } = JSON.parse(body || '{}');
              if (pin !== this.currentPin || Date.now() > this.pinExpiresAt) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'INVALID_OR_EXPIRED_PIN' }));
                return;
              }

              if (typeof peerToken !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(peerToken)) throw new Error('Invalid peer token');
              const secret = crypto.randomBytes(32).toString('hex');
              this.pairSecrets.set(peerToken, secret);
              if (Number.isInteger(port) && port > 0 && port <= 65535) this.discoveredPeers.set(peerToken, { token: peerToken, name: peerName, ip: req.socket.remoteAddress.replace(/^::ffff:/, ''), port, lastSeen: Date.now(), paired: true });
              this.pairedPeers.add(peerToken);
              if (this.onPeerMessage) {
                this.onPeerMessage({
                  type: 'peer_paired',
                  peerToken,
                  peerName,
                });
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                ok: true,
                myToken: this.machineToken,
                myName: this.machineName,
                secret,
              }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // 2. Direct P2P Repo Transfer Endpoint (Authenticated, Disk-Streamed)
        if (req.method === 'POST' && url.pathname === '/p2p/send-repo') {
          const senderToken = String(req.headers['x-machine-token'] || '').trim();
          if (!senderToken || !this.isAuthenticated(senderToken, req.headers['x-pair-secret'])) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'UNPAIRED_SENDER' }));
            return;
          }

          const toolName = (url.searchParams.get('toolName') || 'transferred-repo').replace(/[\\/:*?"<>|]/g, '_');
          const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'work-lan-recv-'));
          const tmpZip = path.join(tmpDir, 'payload.zip');

          try {
            let bytesReceived = 0;
            const MAX_LAN_BYTES = 1024 * 1024 * 1024; // 1GB hard cap
            req.on('data', (chunk) => {
              bytesReceived += chunk.length;
              if (bytesReceived > MAX_LAN_BYTES) {
                req.destroy(new Error('Transfer exceeds 1GB limit'));
              }
            });
            await pipeline(req, fs.createWriteStream(tmpZip));

            const fullBuffer = await fsp.readFile(tmpZip);
            const destDir = path.resolve(this.defaultParent || process.cwd(), toolName);
            const extracted = await extractZipSafely(fullBuffer, destDir, { conflictResolution: 'auto-rename' });

            if (this.onPeerMessage) {
              this.onPeerMessage({
                type: 'repo_received',
                sender: senderToken,
                toolName,
                targetDir: extracted.targetDir,
                meta: extracted.meta,
              });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, targetDir: extracted.targetDir }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          } finally {
            await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
          return;
        }

        // 3. Direct P2P Chat Message Endpoint
        if (req.method === 'POST' && url.pathname === '/p2p/chat') {
          const sender = String(req.headers['x-machine-token'] || '');
          if (!this.isAuthenticated(sender, req.headers['x-pair-secret'])) { res.writeHead(401); res.end(); return; }
          let body = '';
          let bytesReceived = 0;
          req.on('data', chunk => {
            bytesReceived += chunk.length;
            if (bytesReceived > 23 * 1024 * 1024) { req.destroy(); return; }
            body += chunk;
          });
          req.on('end', async () => {
            try {
              const msg = JSON.parse(body || '{}');
              validateRoomId(msg.roomId);
              const members = dmParticipants(msg.roomId);
              if (msg.roomId.startsWith('dm-') && (members.length !== 2 || !members.includes(sender) || !members.includes(this.machineToken))) throw new Error('DM room mismatch');
              if (msg.sender !== sender || typeof msg.id !== 'string' || typeof msg.content !== 'string') throw new Error('Invalid message');
              if (this.onPeerMessage) await this.onPeerMessage({ type: 'chat', message: msg });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        // 4. Authenticated P2P Repo Archive Stream Endpoint
        if (req.method === 'GET' && url.pathname === '/p2p/repo-archive') {
          const senderToken = String(req.headers['x-machine-token'] || url.searchParams.get('token') || '').trim();
          const secret = String(req.headers['x-pair-secret'] || url.searchParams.get('secret') || '').trim();
          if (!senderToken || !this.isAuthenticated(senderToken, secret)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'UNPAIRED_WORKSTATION' }));
            return;
          }

          const repoName = (url.searchParams.get('repo') || '').replace(/[\\/:*?"<>|]/g, '_');
          if (!repoName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'MISSING_REPO_NAME' }));
            return;
          }

          const targetDir = path.resolve(this.defaultParent || process.cwd(), repoName);
          if (!fs.existsSync(targetDir)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'REPO_NOT_FOUND' }));
            return;
          }

          try {
            const { createArchiveFromPath } = await import('./publisher.js');
            const tmpZip = path.join(os.tmpdir(), `repo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.zip`);
            await createArchiveFromPath(targetDir, tmpZip, { trackedOnly: false, sanitize: true });
            res.writeHead(200, { 'Content-Type': 'application/zip' });
            const s = fs.createReadStream(tmpZip);
            s.on('close', () => fs.unlink(tmpZip, () => {}));
            s.pipe(res);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
          return;
        }

        // 5. Git Smart HTTP Pack Endpoints (Authenticated via X-Pair-Secret)
        if (url.pathname === '/p2p/git-upload-pack' || url.pathname === '/p2p/git-receive-pack') {
          const senderToken = String(req.headers['x-machine-token'] || url.searchParams.get('token') || '').trim();
          const secret = String(req.headers['x-pair-secret'] || url.searchParams.get('secret') || '').trim();
          if (!senderToken || !this.isAuthenticated(senderToken, secret)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'UNPAIRED_WORKSTATION' }));
            return;
          }

          const repoName = (url.searchParams.get('repo') || '').replace(/[\\/:*?"<>|]/g, '_');
          const targetDir = repoName ? path.resolve(this.defaultParent || process.cwd(), repoName) : (this.defaultParent || process.cwd());
          if (!fs.existsSync(targetDir)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'REPO_NOT_FOUND' }));
            return;
          }

          const service = url.pathname.endsWith('upload-pack') ? 'upload-pack' : 'receive-pack';
          res.writeHead(200, {
            'Content-Type': `application/x-git-${service}-result`,
            'Cache-Control': 'no-cache',
          });

          const proc = spawn('git', [service, '--stateless-rpc', targetDir]);
          req.pipe(proc.stdin);
          proc.stdout.pipe(res);
          proc.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            }
          });
          return;
        }

        res.writeHead(404);
        res.end();
      });

      this.httpServer.listen(0, '0.0.0.0', () => {
        this.httpPort = this.httpServer.address().port;
        resolve();
      });

      this.httpServer.on('error', reject);
    });
  }

  /**
   * Start UDP Beacon Listener & Broadcaster
   */
  startUdpBeacon() {
    return new Promise((resolve) => {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      let resolved = false;
      const safeResolve = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      this.udpSocket.on('error', (err) => {
        console.warn('[Work LAN] UDP socket notice:', err.message);
        safeResolve();
      });

      this.udpSocket.on('message', (msg, rinfo) => {
        try {
          const payload = JSON.parse(msg.toString('utf8'));
          if (payload.magic === 'WORK_UPDATE') {
            if (payload.token !== this.machineToken && this.onPeerMessage) {
              this.onPeerMessage({
                type: 'work_update_available',
                version: payload.version,
                assetId: payload.assetId,
                downloadUrl: payload.downloadUrl,
                publishedAt: payload.publishedAt,
                sender: payload.token,
              });
            }
            return;
          }
          const isWorkBeacon = payload.magic === 'WORK_P2P' || payload.v === 'work-v4';
          if (!isWorkBeacon || payload.token === this.machineToken) {
            return;
          }

          this.discoveredPeers.set(payload.token, {
            token: payload.token,
            name: payload.name || 'Workstation',
            // Unauthenticated discovery cannot redirect an already paired connection.
            ip: this.pairSecrets.has(payload.token) ? this.discoveredPeers.get(payload.token)?.ip || rinfo.address : rinfo.address,
            port: this.pairSecrets.has(payload.token) ? this.discoveredPeers.get(payload.token)?.port || payload.port : payload.port,
            paired: this.pairedPeers.has(payload.token),
            lastSeen: Date.now(),
          });
        } catch {}
      });

      try {
        this.udpSocket.bind(BROADCAST_PORT, () => {
          try {
            this.udpSocket.setBroadcast(true);
          } catch {}

          this.broadcastBeacon();
          this.beaconTimer = setInterval(() => this.broadcastBeacon(), BEACON_INTERVAL);
          if (this.beaconTimer?.unref) this.beaconTimer.unref();
          safeResolve();
        });
      } catch (bindErr) {
        console.warn('[Work LAN] UDP socket bind notice:', bindErr.message);
        safeResolve();
      }
    });
  }

  /**
   * Broadcast presence to local subnet and all physical candidate networks
   */
  broadcastBeacon() {
    if (!this.udpSocket) return;
    const packet = Buffer.from(JSON.stringify({
      magic: 'WORK_P2P',
      token: this.machineToken,
      name: this.machineName,
      port: this.httpPort,
    }));

    try {
      this.udpSocket.send(packet, 0, packet.length, BROADCAST_PORT, BROADCAST_ADDR);
    } catch {}

    for (const cand of this.networkCandidates || []) {
      if (cand.broadcast && cand.broadcast !== BROADCAST_ADDR) {
        try {
          this.udpSocket.send(packet, 0, packet.length, BROADCAST_PORT, cand.broadcast);
        } catch {}
      }
    }
  }

  /**
   * Broadcast update notification across local subnet via UDP
   */
  broadcastUpdate(updatePayload = {}) {
    if (!this.udpSocket) return;
    const packet = Buffer.from(JSON.stringify({
      magic: 'WORK_UPDATE',
      token: this.machineToken,
      name: this.machineName,
      ...updatePayload,
    }));

    try {
      this.udpSocket.send(packet, 0, packet.length, BROADCAST_PORT, BROADCAST_ADDR);
    } catch {}

    for (const cand of this.networkCandidates || []) {
      if (cand.broadcast && cand.broadcast !== BROADCAST_ADDR) {
        try {
          this.udpSocket.send(packet, 0, packet.length, BROADCAST_PORT, cand.broadcast);
        } catch {}
      }
    }
  }

  /**
   * Purge peers inactive for > 7 seconds
   */
  purgeStalePeers() {
    const now = Date.now();
    for (const [token, peer] of this.discoveredPeers.entries()) {
      if (now - peer.lastSeen > PEER_TIMEOUT && !this.pairSecrets.has(token)) {
        this.discoveredPeers.delete(token);
      }
    }
  }

  /**
   * Get active discovered LAN peers
   */
  getDiscoveredPeers() {
    return Array.from(this.discoveredPeers.values());
  }

  /**
   * Pair with a discovered peer using their 6-digit PIN
   */
  async pairWithPeer(peerToken, inputPin) {
    const peer = this.discoveredPeers.get(peerToken);
    if (!peer) {
      throw new Error('Peer not detected on local Wi-Fi');
    }

    const payload = JSON.stringify({
      peerToken: this.machineToken,
      peerName: this.machineName,
      port: this.httpPort,
      pin: inputPin.trim(),
    });

    const url = `http://${peer.ip}:${peer.port}/p2p/pair`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Pairing rejected');
    }

    const data = await res.json();
    if (data.myToken !== peerToken || typeof data.secret !== 'string') throw new Error('Peer identity or secure pairing unavailable');
    this.pairSecrets.set(peerToken, data.secret);
    this.pairedPeers.add(peerToken);
    peer.paired = true;
    return {
      ok: true,
      peerToken,
      alias: peer.name,
      ip: peer.ip,
      port: peer.port,
    };
  }

  /**
   * Direct pair via IP:Port or work:// pair link (fallback when UDP is blocked by router or firewall)
   */
  async pairDirect(targetAddress, inputPin) {
    let host = '';
    let port = 0;
    let pin = (inputPin || '').trim();

    if (typeof targetAddress === 'string' && (targetAddress.startsWith('work://') || targetAddress.startsWith('http://'))) {
      try {
        const parsedUrl = new URL(targetAddress.replace(/^work:\/\//, 'http://'));
        host = parsedUrl.searchParams.get('host') || parsedUrl.hostname;
        port = Number(parsedUrl.port || parsedUrl.searchParams.get('port'));
        if (!pin) {
          pin = parsedUrl.searchParams.get('pin') || '';
        }
      } catch {}
    } else if (typeof targetAddress === 'string') {
      const trimmed = targetAddress.trim().replace(/^http:\/\//, '');
      const parts = trimmed.split(':');
      host = parts[0];
      port = Number(parts[1] || 0);
    }

    if (!host) {
      throw new Error('Valid host IP or address required');
    }
    if (!pin) {
      throw new Error('6-digit pairing PIN required');
    }

    if (!port) {
      for (const p of this.discoveredPeers.values()) {
        if (p.ip === host) {
          port = p.port;
          break;
        }
      }
    }
    if (!port) {
      throw new Error('Port required (format: 192.168.x.x:PORT)');
    }

    const payload = JSON.stringify({
      peerToken: this.machineToken,
      peerName: this.machineName,
      port: this.httpPort,
      pin,
    });

    const url = `http://${host}:${port}/p2p/pair`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Pairing rejected');
    }

    const data = await res.json();
    const peerToken = data.myToken || `WK-LAN-${host.replace(/\./g, '_')}`;
    const peerName = data.myName || `Peer (${host})`;

    if (typeof data.secret !== 'string') throw new Error('Secure pairing unavailable');
    this.pairSecrets.set(peerToken, data.secret);
    this.pairedPeers.add(peerToken);
    this.discoveredPeers.set(peerToken, {
      token: peerToken,
      name: peerName,
      ip: host,
      port,
      paired: true,
      lastSeen: Date.now(),
    });

    return {
      ok: true,
      peerToken,
      alias: peerName,
      ip: host,
      port,
    };
  }

  /**
   * Stream a clean repo directly to a paired LAN peer
   */
  async streamRepoToPeer(peerToken, toolName, zipBuffer) {
    const peer = this.discoveredPeers.get(peerToken);
    if (!this.pairSecrets.has(peerToken)) throw new Error('Peer must be securely paired');
    if (!peer) {
      throw new Error('Peer offline or not reachable on LAN');
    }

    const url = `http://${peer.ip}:${peer.port}/p2p/send-repo?toolName=${encodeURIComponent(toolName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Machine-Token': this.machineToken,
        'X-Pair-Secret': this.pairSecrets.get(peerToken),
      },
      body: zipBuffer,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'LAN transfer failed');
    }

    return await res.json();
  }

  /**
   * Broadcast a chat message directly to all paired LAN peers
   */
  isAuthenticated(token, secret) {
    const expected = this.pairSecrets.get(token);
    return Boolean(expected && typeof secret === 'string' && secret.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected)));
  }

  async sendChatToPeers(message) {
    validateRoomId(message.roomId);
    const members = dmParticipants(message.roomId);
    if (message.roomId.startsWith('dm-') && (members.length !== 2 || !members.includes(this.machineToken))) throw new Error('DM room mismatch');
    const results = [];
    for (const [token, peer] of this.discoveredPeers.entries()) {
      if (this.pairSecrets.has(token) && peer.ip && peer.port && (!message.roomId.startsWith('dm-') || members.includes(token))) {
        try {
          const url = `http://${peer.ip}:${peer.port}/p2p/chat`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Machine-Token': this.machineToken, 'X-Pair-Secret': this.pairSecrets.get(token) },
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(3000),
          });
          results.push({ token, ok: res.ok, status: res.status });
        } catch {
          results.push({ token, ok: false });
        }
      }
    }
    return results;
  }

  /**
   * Look up peer by username/handle (e.g. "@alice" or "alice")
   */
  findPeerByHandle(handle) {
    const clean = (handle || '').replace(/^@/, '').toLowerCase().trim();
    if (!clean) return null;
    for (const peer of this.discoveredPeers.values()) {
      const peerName = (peer.name || '').toLowerCase();
      const peerToken = (peer.token || '').toLowerCase();
      if (peerName === clean || peerToken.includes(clean)) {
        return peer;
      }
    }
    return null;
  }
}
