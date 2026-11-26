import crypto from 'node:crypto';

const DEFAULT_RELAYS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

function encodeRemainingLength(len) {
  const bytes = [];
  let x = len;
  do {
    let encoded = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) encoded |= 128;
    bytes.push(encoded);
  } while (x > 0);
  return Buffer.from(bytes);
}

function mqttString(str) {
  const buf = Buffer.from(String(str), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

function buildConnectPacket(clientId) {
  const protocol = mqttString('MQTT');
  const flags = Buffer.from([0x04, 0x02, 0x00, 30]); // v3.1.1, clean session, 30s keepalive
  const payload = mqttString(clientId);
  const body = Buffer.concat([protocol, flags, payload]);
  return Buffer.concat([Buffer.from([0x10]), encodeRemainingLength(body.length), body]);
}

function buildSubscribePacket(packetId, topic) {
  const idBuf = Buffer.alloc(2);
  idBuf.writeUInt16BE(packetId & 0xffff || 1, 0);
  const body = Buffer.concat([idBuf, mqttString(topic), Buffer.from([0x00])]);
  return Buffer.concat([Buffer.from([0x82]), encodeRemainingLength(body.length), body]);
}

function buildPublishPacket(topic, payloadBuf) {
  const body = Buffer.concat([mqttString(topic), payloadBuf]);
  return Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(body.length), body]);
}

function parseMqttPackets(buffer, onPacket) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const header = buffer[offset];
    let multiplier = 1;
    let remaining = 0;
    let lenBytes = 0;
    let complete = false;
    for (let i = offset + 1; i < buffer.length && i < offset + 5; i++) {
      const byte = buffer[i];
      remaining += (byte & 127) * multiplier;
      multiplier *= 128;
      lenBytes++;
      if ((byte & 128) === 0) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    const totalLen = 1 + lenBytes + remaining;
    if (offset + totalLen > buffer.length) break;
    onPacket(header, buffer.subarray(offset + 1 + lenBytes, offset + totalLen));
    offset += totalLen;
  }
  return offset > 0 ? buffer.subarray(offset) : buffer;
}

/**
 * End-to-end encrypted real-time PubSub bus over public MQTT WebSocket relays.
 * Zero external packages, <50ms warm delivery, multi-broker failover.
 */
export class RealtimeRelayBus {
  constructor({ onEvent, relays = DEFAULT_RELAYS, disabled = false } = {}) {
    this.onEvent = onEvent;
    this.relays = Array.isArray(relays) && relays.length ? relays : DEFAULT_RELAYS;
    this.disabled = disabled || typeof globalThis.WebSocket !== 'function';
    this.disposed = false;
    this.subscriptions = new Map(); // topic -> { roomId, secret }
    this.topicToRoom = new Map(); // topic -> { roomId, secret }
    this.connections = new Map(); // url -> { ws, ready, rxBuf, pingTimer, reconnectTimer }
    this.seenIds = new Set();
    this.packetSeq = 1;
  }

  deriveChannel(roomId, secret = 'dsh-work-public') {
    const cleanSecret = String(secret || 'dsh-work-public');
    const topicHash = crypto
      .createHash('sha256')
      .update(`topic:${cleanSecret}:${roomId}`)
      .digest('hex')
      .slice(0, 28);
    const key = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(cleanSecret, 'utf8'), Buffer.from(roomId, 'utf8'), Buffer.from('dsh-work-e2ee-v1'), 32)
    );
    return { topic: `dsh-work/v2/${topicHash}`, key };
  }

  encrypt(roomId, secret, payload) {
    const { topic, key } = this.deriveChannel(roomId, secret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const pt = Buffer.from(JSON.stringify(payload), 'utf8');
    const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wire = Buffer.from(
      JSON.stringify({
        v: 1,
        iv: iv.toString('base64url'),
        tag: tag.toString('base64url'),
        ct: ct.toString('base64url'),
      }),
      'utf8'
    );
    return { topic, wire };
  }

  decrypt(roomId, secret, rawBuf) {
    const { key } = this.deriveChannel(roomId, secret);
    const envelope = JSON.parse(rawBuf.toString('utf8'));
    if (!envelope || envelope.v !== 1 || !envelope.iv || !envelope.tag || !envelope.ct) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  }

  rememberSeen(eventId) {
    if (!eventId) return false;
    if (this.seenIds.has(eventId)) return true;
    if (this.seenIds.size >= 500) this.seenIds.delete(this.seenIds.values().next().value);
    this.seenIds.add(eventId);
    return false;
  }

  connectRelay(url) {
    if (this.disabled || this.disposed) return null;
    const existing = this.connections.get(url);
    if (existing?.ws && existing.ws.readyState <= 1) return existing;

    const entry = {
      url,
      ws: null,
      ready: false,
      rxBuf: Buffer.alloc(0),
      pingTimer: null,
      reconnectTimer: null,
    };
    if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);
    this.connections.set(url, entry);

    try {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      entry.ws = ws;

      ws.onopen = () => {
        if (this.disposed) { try { ws.close(); } catch {} return; }
        const clientId = `dsh_${crypto.randomBytes(5).toString('hex')}`;
        try { ws.send(buildConnectPacket(clientId)); } catch {}
      };

      ws.onmessage = (ev) => {
        if (this.disposed) return;
        const chunk = Buffer.from(ev.data);
        entry.rxBuf = parseMqttPackets(Buffer.concat([entry.rxBuf, chunk]), (header, body) => {
          const type = header & 0xf0;
          if (type === 0x20 && body.length >= 2 && body[1] === 0) {
            entry.ready = true;
            for (const sub of this.subscriptions.values()) {
              try { ws.send(buildSubscribePacket(this.packetSeq++, sub.topic)); } catch {}
            }
            if (entry.pingTimer) clearInterval(entry.pingTimer);
            entry.pingTimer = setInterval(() => {
              if (entry.ready && ws.readyState === 1) {
                try { ws.send(Buffer.from([0xc0, 0x00])); } catch {}
              }
            }, 22000);
            entry.pingTimer.unref?.();
          } else if (type === 0x30 && body.length >= 2) {
            const topicLen = body.readUInt16BE(0);
            if (2 + topicLen > body.length) return;
            const topic = body.subarray(2, 2 + topicLen).toString('utf8');
            const qos = (header >> 1) & 0x03;
            const payloadStart = 2 + topicLen + (qos > 0 ? 2 : 0);
            if (payloadStart > body.length) return;
            const sub = this.topicToRoom.get(topic);
            if (!sub) return;
            try {
              const event = this.decrypt(sub.roomId, sub.secret, body.subarray(payloadStart));
              if (!event || this.rememberSeen(event.eventId)) return;
              this.onEvent?.({ ...event, roomId: sub.roomId, relayUrl: url });
            } catch {}
          }
        });
      };

      const scheduleReconnect = () => {
        entry.ready = false;
        if (entry.pingTimer) { clearInterval(entry.pingTimer); entry.pingTimer = null; }
        if (this.disposed || this.subscriptions.size === 0 || entry.reconnectTimer) return;
        entry.reconnectTimer = setTimeout(() => {
          entry.reconnectTimer = null;
          if (!this.disposed && this.subscriptions.size > 0) this.connectRelay(url);
        }, 4000);
        entry.reconnectTimer.unref?.();
      };

      ws.onclose = scheduleReconnect;
      ws.onerror = () => {};
    } catch {
      entry.ready = false;
    }
    return entry;
  }

  ensureRelaysConnected() {
    if (this.disabled || this.disposed) return;
    for (const url of this.relays.slice(0, 2)) this.connectRelay(url);
  }

  subscribeRoom(roomId, secret) {
    if (this.disabled || this.disposed || !roomId) return null;
    const { topic } = this.deriveChannel(roomId, secret);
    const meta = { roomId, secret: String(secret || 'dsh-work-public'), topic };
    const isNew = !this.subscriptions.has(topic);
    this.subscriptions.set(topic, meta);
    this.topicToRoom.set(topic, meta);
    this.ensureRelaysConnected();
    if (isNew) {
      for (const entry of this.connections.values()) {
        if (entry.ready && entry.ws?.readyState === 1) {
          try { entry.ws.send(buildSubscribePacket(this.packetSeq++, topic)); } catch {}
        }
      }
    }
    return topic;
  }

  async publishRoomEvent(roomId, secret, payload) {
    if (this.disabled || this.disposed || !roomId) return { sentRelays: 0 };
    this.subscribeRoom(roomId, secret);
    const eventId = payload?.eventId || crypto.randomUUID();
    this.rememberSeen(eventId);
    const { topic, wire } = this.encrypt(roomId, secret, { ...payload, eventId, emittedAt: Date.now() });
    const packet = buildPublishPacket(topic, wire);

    let active = [...this.connections.values()].filter(e => e.ready && e.ws?.readyState === 1);
    if (active.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 650));
      active = [...this.connections.values()].filter(e => e.ready && e.ws?.readyState === 1);
    }
    let sentRelays = 0;
    for (const entry of active) {
      try {
        entry.ws.send(packet);
        sentRelays++;
      } catch {}
    }
    return { sentRelays, eventId };
  }

  getStatus() {
    const ready = [...this.connections.values()].filter(e => e.ready && e.ws?.readyState === 1).map(e => e.url);
    return { enabled: !this.disabled, connectedRelays: ready.length, urls: ready, subscribedRooms: this.subscriptions.size };
  }

  async stop() {
    this.disposed = true;
    for (const entry of this.connections.values()) {
      if (entry.pingTimer) clearInterval(entry.pingTimer);
      if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
      if (entry.ws) {
        try { entry.ws.close(); } catch {}
      }
    }
    this.connections.clear();
    this.subscriptions.clear();
    this.topicToRoom.clear();
  }
}
