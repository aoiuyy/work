import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apply } from '../index.js';
const rpcSource = readFileSync(new URL('../ui/shared/rpc.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(rpcSource + ';globalThis.call = callWorkRpc;', context);

test('Work uses current connection.rpc without a connection.fetch method', async () => {
  const calls = [];
  const connection = { rpc: { async call(...args) { calls.push(args); return { ok: true, value: { ready: true } }; } } };
  const result = await context.call(connection, 'musicState');
  assert.equal(result.value.ready, true);
  assert.equal(calls[0][0], '/api');
  assert.equal(calls[0][1], 'work/musicState');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { args: {} });
});
test('Work transport errors remain explicit and business failures are preserved', async () => {
  const unavailable = await context.call({ rpc: { call: async () => { throw new Error('HTTP 403'); } } }, 'musicState');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error.message, 'HTTP 403');
  const refused = { ok: false, error: { code: 'DENIED', message: 'Pair first', details: {} } };
  assert.equal(await context.call({ rpc: { call: async () => refused } }, 'sendChatMessage'), refused);
});
test('Chats action routes exist and return business envelopes instead of HTTP 404', async () => {
  const routes = new Map(); const disposals = [];
  apply({ connection: {
    rpc: { intercept() { throw new Error('The shared /api interceptor is already owned by DSH'); } },
    fetch: { register(route) { routes.set(route.path, route); } },
  }, on(name, callback) { if (name === 'dispose') disposals.push(callback); } }, {});
  try {
    for (const action of ['editChatMessage', 'deleteChatMessage', 'pinChatMessage', 'reactChatMessage', 'readAttachmentFile', 'deleteAttachmentFile']) {
      const route = routes.get(`/api/work/${action}`);
      assert.ok(route, action);
      const response = await route.fetch(new Request(`http://localhost/api/work/${action}`, {
        method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'chats-route-test', method: `work/${action}`, payload: { args: {} } }),
      }));
      assert.equal(response.status, 200);
      const { result } = await response.json();
      assert.equal(result.ok, false);
      assert.equal(typeof result.error.code, 'string');
      assert.equal(typeof result.error.message, 'string');
      assert.equal(typeof result.error.details, 'object');
    }
  } finally { for (const dispose of disposals) await dispose(); }
});

test('Host errors satisfy strict current Connection response validation', async () => {
  const routes = new Map(); const disposals = [];
  apply({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => {}; } } }, on(name, callback) { if (name === 'dispose') disposals.push(callback); } }, {});
  try {
    const route = routes.get('/api/work/executeChatCommand');
    const response = await route.fetch(new Request('http://localhost/api/work/executeChatCommand', { method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'transport-test', method: 'work/executeChatCommand', payload: { args: { text: '/invalid' } } }) }));
    const { result } = await response.json();
    assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, 'string');
    assert.equal(typeof result.error.message, 'string');
    assert.equal(typeof result.error.details, 'object');
  } finally { for (const dispose of disposals) await dispose(); }
});
