import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { apply } from '../index.js';
import { LanDiscoveryEngine } from '../lib/engines/lan-discovery.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-chat-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vault = {
    readMachineProfile: async () => ({ machineToken: 'WK-SELF', machineName: 'Fixture' }),
    readWorkConfig: async () => ({}),
    readGithubAuth: async () => null,
    writeGithubAuth: async () => null,
    deleteGithubAuth: async () => null,
    writeMachineProfile: async () => null,
    readPeerLinks: async () => null,
    writePeerLinks: async () => null,
    writeWorkConfig: async () => null,
  };
  class MockLanEngine {
    constructor(options) { globalThis.__workChatIncoming = options.onPeerMessage; }
    async start() {}
    async stop() {}
    async sendChatToPeers(m) { globalThis.__workChatOutbound = m; return []; }
  }
  const routes = new Map();
  const disposals = [];
  apply(
    { connection: { fetch: { register(r) { routes.set(r.path, r); } } }, on(_, fn) { disposals.push(fn); } },
    {},
    { dataDir: path.join(dir, 'data'), vault, LanDiscoveryEngine: MockLanEngine }
  );
  t.after(async () => { for (const fn of disposals) await fn(); delete globalThis.__workChatOutbound; delete globalThis.__workChatIncoming; });
  async function rpc(action, args = {}) {
    const response = await routes.get('/api/work/' + action).fetch(new Request('http://localhost/api/work/' + action, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'work/' + action, payload: { args } }),
    }));
    return (await response.json()).result;
  }
  return { dir, rpc, routes };
}

test('chat mutations persist ownership, edits, pins, reactions and canonical replies', async t => {
  const { dir, rpc } = await fixture(t);
  const roomId = 'channel:test';
  const first = (await rpc('sendChatMessage', { roomId, content: 'original' })).value;
  const reply = await rpc('sendChatMessage', { roomId, content: 'reply', replyTo: { id: first.id, content: 'forged' } });
  assert.equal(reply.value.replyTo.content, 'original');
  assert.equal((await rpc('sendChatMessage', { roomId, content: 'bad', replyTo: { id: 'missing' } })).ok, false);
  const edit = await rpc('editChatMessage', { roomId, messageId: first.id, newContent: 'edited' });
  assert.equal(edit.value.isEdited, true);
  assert.ok(edit.value.editedAt);
  assert.equal((await rpc('pinChatMessage', { roomId, messageId: first.id, isPinned: true })).value.isPinned, true);
  assert.deepEqual((await rpc('reactChatMessage', { roomId, messageId: first.id, reaction: 'fire' })).value.reactions.fire, ['WK-SELF']);
  assert.deepEqual((await rpc('reactChatMessage', { roomId, messageId: first.id, reaction: 'fire' })).value.reactions.fire, []);
  assert.equal((await rpc('reactChatMessage', { roomId, messageId: first.id, reaction: 'heart' })).ok, false);
  assert.equal((await rpc('reactChatMessage', { roomId, messageId: first.id, reaction: '__proto__' })).ok, false);
  const hits = (await rpc('searchChatMessages', { query: 'edited' })).value;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, first.id);
  let disk = JSON.parse(await fs.readFile(path.join(dir, 'data/messages.json')));
  assert.equal(disk.rooms[roomId].messages[0].content, 'edited');
  assert.equal(disk.rooms[roomId].messages[0].isPinned, true);
  assert.equal((await rpc('deleteChatMessage', { roomId, messageId: first.id })).value.deleted, true);
  disk = JSON.parse(await fs.readFile(path.join(dir, 'data/messages.json')));
  assert.equal(disk.rooms[roomId].messages.length, 1);
  assert.ok(disk.rooms[roomId].deletedIds.includes(first.id));
  assert.equal((await rpc('searchChatMessages', { query: 'edited' })).value.length, 0);
});

test('foreign messages cannot be edited or deleted', async t => {
  const { dir, rpc } = await fixture(t);
  await fs.mkdir(path.join(dir, 'data'));
  await fs.writeFile(path.join(dir, 'data/messages.json'), JSON.stringify({ rooms: { 'channel:test': { messages: [{ id: 'foreign', sender: 'WK-OTHER', content: 'original' }] } } }));
  for (const action of ['editChatMessage', 'deleteChatMessage']) {
    const result = await rpc(action, { roomId: 'channel:test', messageId: 'foreign', newContent: 'forged' });
    assert.equal(result.error.code, 'FORBIDDEN');
  }
});

test('attachment RPC roundtrip, LAN bytes, limits, traversal and symlink defenses', async t => {
  const { dir, rpc } = await fixture(t);
  const rawBase64 = Buffer.from('voice fixture').toString('base64');
  const sent = await rpc('sendChatMessage', { roomId: 'channel:test', type: 'voice', fileMeta: { name: '../voice.webm', mimeType: 'audio/webm', audioUrl: 'data:audio/webm;base64,' + rawBase64 } });
  assert.equal(sent.ok, true);
  const filePath = sent.value.fileMeta.filePath;
  assert.equal(sent.value.fileMeta.rawBase64, undefined);
  assert.equal(globalThis.__workChatOutbound.fileMeta.filePath, undefined);
  assert.equal(globalThis.__workChatOutbound.fileMeta.rawBase64, rawBase64);
  const read = await rpc('readAttachmentFile', { filePath });
  assert.equal(read.value.rawBase64, rawBase64);
  assert.equal(read.value.mimeType, 'audio/webm');
  await globalThis.__workChatIncoming({ type: 'chat', message: { id: 'received', roomId: 'channel:test', sender: 'WK-PEER', content: '', type: 'voice', fileMeta: { name: 'remote.webm', mimeType: 'audio/webm', filePath: 'C:/private/secret', rawBase64 } } });
  const incoming = (await rpc('getChatMessages', { roomId: 'channel:test' })).value.find(m => m.id === 'received');
  assert.notEqual(incoming.fileMeta.filePath, 'C:/private/secret');
  assert.equal(incoming.fileMeta.rawBase64, undefined);
  assert.equal((await rpc('readAttachmentFile', { filePath: incoming.fileMeta.filePath })).value.rawBase64, rawBase64);
  const outside = path.join(dir, 'outside.txt');
  await fs.writeFile(outside, 'private');
  for (const action of ['readAttachmentFile', 'deleteAttachmentFile']) {
    assert.equal((await rpc(action, { filePath: outside })).ok, false);
    assert.equal((await rpc(action, { filePath: path.join(dir, 'data/attachments/../messages.json') })).ok, false);
  }
  const link = path.join(dir, 'data/attachments/link.txt');
  try {
    await fs.symlink(outside, link);
    assert.equal((await rpc('readAttachmentFile', { filePath: link })).ok, false);
    assert.equal((await rpc('deleteAttachmentFile', { filePath: link })).ok, false);
  } catch (error) { if (error.code !== 'EPERM') throw error; t.diagnostic('File symlink unavailable; directory junction checked instead'); }
  const tooLarge = Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64');
  assert.equal((await rpc('sendChatMessage', { roomId: 'channel:test', fileMeta: { name: 'large' }, rawBase64: tooLarge })).ok, false);
  assert.equal((await rpc('sendChatMessage', { roomId: 'channel:test', fileMeta: { name: 'invalid' }, rawBase64: '%%%%' })).ok, false);
  assert.equal((await rpc('deleteAttachmentFile', { filePath })).value.deleted, true);
  assert.equal((await rpc('readAttachmentFile', { filePath })).ok, false);
  await fs.rm(path.join(dir, 'data/attachments'), { recursive: true });
  await fs.symlink(dir, path.join(dir, 'data/attachments'), 'junction');
  assert.equal((await rpc('sendChatMessage', { roomId: 'channel:test', fileMeta: { name: 'escape' }, rawBase64 })).ok, false);
});

test('authenticated LAN accepts bounded attachment bodies above former 1MiB cap', async t => {
  let received;
  const engine = new LanDiscoveryEngine({ machineToken: 'WK-RECEIVER', machineName: 'Fixture', onPeerMessage: async event => { received = event.message; } });
  engine.pairSecrets.set('WK-SENDER', 'fixture-secret');
  await engine.startHttpServer();
  t.after(() => engine.stop());
  const payload = { id: 'lan-fixture', sender: 'WK-SENDER', roomId: 'channel:test', content: '', fileMeta: { name: 'payload.bin', rawBase64: Buffer.alloc(1024 * 1024).toString('base64') } };
  const response = await fetch(`http://127.0.0.1:${engine.httpPort}/p2p/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Machine-Token': 'WK-SENDER', 'X-Pair-Secret': 'fixture-secret' }, body: JSON.stringify(payload) });
  assert.equal(response.status, 200);
  assert.equal(received.fileMeta.rawBase64, payload.fileMeta.rawBase64);
  const denied = await fetch(`http://127.0.0.1:${engine.httpPort}/p2p/chat`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 401);
});

test('dead WebRTC signaling routes are removed and 2-way delete cleans attachment file', async t => {
  const { routes, rpc } = await fixture(t);
  assert.equal(routes.has('/api/work/getSignaling'), false);
  assert.equal(routes.has('/api/work/postSignaling'), false);
  const rawBase64 = Buffer.from('delete-me').toString('base64');
  const sent = await rpc('sendChatMessage', { roomId: 'channel:cleanup', type: 'voice', fileMeta: { name: 'v.webm', mimeType: 'audio/webm', rawBase64 } });
  const fp = sent.value.fileMeta.filePath;
  assert.equal((await rpc('readAttachmentFile', { filePath: fp })).ok, true);
  assert.equal((await rpc('deleteChatMessage', { roomId: 'channel:cleanup', messageId: sent.value.id })).value.deleted, true);
  assert.equal((await rpc('readAttachmentFile', { filePath: fp })).ok, false);
});

test('deleteChatRoom removes all room messages and local attachments', async t => {
  const { dir, rpc } = await fixture(t);
  const rawBase64 = Buffer.from('room-cleanup').toString('base64');
  const sent = await rpc('sendChatMessage', { roomId: 'dm-a--b', type: 'voice', fileMeta: { name: 'a.webm', mimeType: 'audio/webm', rawBase64 } });
  const fp = sent.value.fileMeta.filePath;
  const res = await rpc('deleteChatRoom', { roomId: 'dm-a--b' });
  assert.equal(res.ok, true);
  assert.equal(res.value.removedCount, 1);
  assert.equal((await rpc('readAttachmentFile', { filePath: fp })).ok, false);
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'data/messages.json')));
  assert.equal(disk.rooms['dm-a--b'].messages.length, 0);
  assert.ok(disk.rooms['dm-a--b'].deletedIds.includes(sent.value.id));
});
