import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeGithubAuth, deleteGithubAuth } from '../lib/engines/dpapi-vault.js';
import { apply } from '../index.js';

test('Work registers exact /api/work routes and returns an RPC envelope', async () => {
  const vaultDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-work-index-test-'));
  const originalVaultDir = process.env.DSH_WORK_VAULT_DIR;
  const routes = new Map();
  const disposers = [];
  const ctx = {
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => {}; } } },
    on(event, dispose) { if (event === 'dispose') disposers.push(dispose); },
    get() { return null; },
  };
  process.env.DSH_WORK_VAULT_DIR = vaultDir;

  try {
    apply(ctx, {});
    const route = routes.get('/api/work/getConfig');
    assert.ok(route);
    assert.equal(route.methods[0], 'POST');
    assert.equal(route.requestBody, 'buffered');

    const response = await route.fetch(new Request('http://localhost/api/work/getConfig', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'work/getConfig', payload: { args: {} } }),
    }));

    assert.equal(response.status, 200);
    const envelope = await response.json();
    assert.equal(envelope.rpcId, 'probe');
    assert.equal(envelope.result.ok, true);
    assert.equal(typeof envelope.result.value.machineToken, 'string');
    assert.ok(envelope.result.value.machineToken.startsWith('WK-'));

    // Test runQuickCommand
    const runRoute = routes.get('/api/work/runQuickCommand');
    assert.ok(runRoute);
    const runRes = await runRoute.fetch(new Request('http://localhost/api/work/runQuickCommand', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'cmd-test',
        method: 'work/runQuickCommand',
        payload: { args: { cwd: vaultDir, command: 'echo hello' } },
      }),
    }));
    assert.equal(runRes.status, 200);
    const runEnv = await runRes.json();
    assert.equal(runEnv.result.ok, true);
    assert.ok(runEnv.result.value.output.includes('hello'));

    // Test heartbeat and discovered machines routes exist
    const hbRoute = routes.get('/api/work/syncMachineHeartbeat');
    assert.ok(hbRoute);
    const discRoute = routes.get('/api/work/listDiscoveredMachines');
    assert.ok(discRoute);

    // Test packageRepo route
    const pkgRoute = routes.get('/api/work/packageRepo');
    assert.ok(pkgRoute);

    // Test setConfig defaultParent persistence
    const setCfgRoute = routes.get('/api/work/setConfig');
    assert.ok(setCfgRoute);
    const setCfgRes = await setCfgRoute.fetch(new Request('http://localhost/api/work/setConfig', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'cfg-test',
        method: 'work/setConfig',
        payload: { args: { defaultParent: 'D:\\TestDownload' } },
      }),
    }));
    assert.equal(setCfgRes.status, 200);
    const setCfgEnv = await setCfgRes.json();
    assert.equal(setCfgEnv.result.ok, true);
    assert.equal(setCfgEnv.result.value.defaultParent, 'D:\\TestDownload');

    // Test all LAN and Connection Hub routes are registered (prevents HTTP 404 regressions)
    const expectedActions = [
      'getLanStatus',
      'refreshLanPin',
      'pairLanPeer',
      'sendRepoDirectLan',
      'requestDeviceLogin',
      'pollDeviceLogin',
      'pickDirectory',
      'pickFile',
      'getMachineProfile',
      'getPeerLinks',
      'savePeerLink',
      'removePeerLink',
    ];
    for (const action of expectedActions) {
      assert.ok(routes.has('/api/work/' + action), `Route /api/work/${action} must be registered`);
    }

    // Test refreshLanPin returns HTTP 200 with new PIN
    const refreshPinRoute = routes.get('/api/work/refreshLanPin');
    assert.ok(refreshPinRoute);
    const pinRes = await refreshPinRoute.fetch(new Request('http://localhost/api/work/refreshLanPin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'pin-test',
        method: 'work/refreshLanPin',
        payload: { args: {} },
      }),
    }));
    assert.equal(pinRes.status, 200);
    const pinEnv = await pinRes.json();
    assert.equal(pinEnv.result.ok, true);
    assert.match(pinEnv.result.value.pin, /^\d{6}$/);
    assert.ok(pinEnv.result.value.pairLink.includes('pin=' + pinEnv.result.value.pin));

    // Test getLanStatus returns HTTP 200 with localIp and pin
    const lanStatusRoute = routes.get('/api/work/getLanStatus');
    assert.ok(lanStatusRoute);
    const lanRes = await lanStatusRoute.fetch(new Request('http://localhost/api/work/getLanStatus', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'lan-test',
        method: 'work/getLanStatus',
        payload: { args: {} },
      }),
    }));
    assert.equal(lanRes.status, 200);
    const lanEnvJson = await lanRes.json();
    assert.equal(lanEnvJson.result.ok, true);
    assert.ok(lanEnvJson.result.value.localIp);
    assert.equal(lanEnvJson.result.value.pin, pinEnv.result.value.pin);

    // Test sendChatMessage works offline / without GitHub auth via local store
    const sendChatRoute = routes.get('/api/work/sendChatMessage');
    assert.ok(sendChatRoute);
    const sendChatRes = await sendChatRoute.fetch(new Request('http://localhost/api/work/sendChatMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'chat-test',
        method: 'work/sendChatMessage',
        payload: { args: { roomId: 'test-room', content: 'Hello local mesh' } },
      }),
    }));
    assert.equal(sendChatRes.status, 200);
    const sendChatEnv = await sendChatRes.json();
    assert.equal(sendChatEnv.result.ok, true);
    assert.equal(sendChatEnv.result.value.content, 'Hello local mesh');

    // Test getChatMessages returns the sent message
    const getChatRoute = routes.get('/api/work/getChatMessages');
    assert.ok(getChatRoute);
    const getChatRes = await getChatRoute.fetch(new Request('http://localhost/api/work/getChatMessages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'get-chat-test',
        method: 'work/getChatMessages',
        payload: { args: { roomId: 'test-room' } },
      }),
    }));
    assert.equal(getChatRes.status, 200);
    const getChatEnv = await getChatRes.json();
    assert.equal(getChatEnv.result.ok, true);
    assert.ok(Array.isArray(getChatEnv.result.value));
    assert.ok(getChatEnv.result.value.some(m => m.content === 'Hello local mesh'));

    // Test stopQuickCommand
    const stopCmdRoute = routes.get('/api/work/stopQuickCommand');
    assert.ok(stopCmdRoute);
    const stopCmdRes = await stopCmdRoute.fetch(new Request('http://localhost/api/work/stopQuickCommand', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'stop-cmd-test',
        method: 'work/stopQuickCommand',
        payload: { args: { pid: 999999 } },
      }),
    }));
    assert.equal(stopCmdRes.status, 200);
    const stopCmdEnv = await stopCmdRes.json();
    assert.equal(stopCmdEnv.result.ok, true);
    assert.equal(stopCmdEnv.result.value.stopped, false);

    // Test generateGitPatch route
    const patchRoute = routes.get('/api/work/generateGitPatch');
    assert.ok(patchRoute);
    const patchRes = await patchRoute.fetch(new Request('http://localhost/api/work/generateGitPatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'patch-test',
        method: 'work/generateGitPatch',
        payload: { args: { targetPath: vaultDir } },
      }),
    }));
    assert.equal(patchRes.status, 200);
    const patchEnvelope = await patchRes.json();
    assert.equal(patchEnvelope.result.ok, false);
    assert.equal(patchEnvelope.result.error.code, 'GIT_PATCH_FAILED');
    assert.equal(typeof patchEnvelope.result.error.message, 'string');
    assert.deepEqual(patchEnvelope.result.error.details, {});

    // Test checkForWorkUpdates route
    const updateRoute = routes.get('/api/work/checkForWorkUpdates');
    assert.ok(updateRoute);
    const updateRes = await updateRoute.fetch(new Request('http://localhost/api/work/checkForWorkUpdates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'update-test',
        method: 'work/checkForWorkUpdates',
        payload: { args: {} },
      }),
    }));
    assert.equal(updateRes.status, 200);
    const updateEnv = await updateRes.json();
    assert.equal(updateEnv.result.ok, true);
    assert.equal(typeof updateEnv.result.value.currentVersion, 'string');

    // Test merge-conflict routes are wired in handleAction (not ENDPOINT_NOT_FOUND)
    for (const mergeAction of ['getMergeConflicts', 'resolveMergeConflict', 'completeMerge', 'abortMerge']) {
      const mRoute = routes.get(`/api/work/${mergeAction}`);
      assert.ok(mRoute, `Route /api/work/${mergeAction} must exist`);
      const mRes = await mRoute.fetch(new Request(`http://localhost/api/work/${mergeAction}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `merge-${mergeAction}`,
          method: `work/${mergeAction}`,
          payload: { args: { repoPath: vaultDir, filePath: 'app.txt', strategy: 'ours' } },
        }),
      }));
      assert.equal(mRes.status, 200);
      const mEnv = await mRes.json();
      assert.notEqual(mEnv.result.error?.code, 'ENDPOINT_NOT_FOUND');
    }
  } finally {
    for (const dispose of disposers) dispose();
    if (originalVaultDir === undefined) delete process.env.DSH_WORK_VAULT_DIR;
    else process.env.DSH_WORK_VAULT_DIR = originalVaultDir;
    await rm(vaultDir, { recursive: true, force: true });
  }
});
