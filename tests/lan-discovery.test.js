// Unit tests for lan-discovery.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { LanDiscoveryEngine, generatePairingPin } from '../lib/engines/lan-discovery.js';

test('generatePairingPin returns 6-digit numeric string', () => {
  const pin = generatePairingPin();
  assert.equal(typeof pin, 'string');
  assert.equal(pin.length, 6);
  assert.match(pin, /^\d{6}$/);
});

test('LanDiscoveryEngine starts HTTP & UDP listeners and pairs with valid PIN', async () => {
  const engineA = new LanDiscoveryEngine({
    machineToken: 'WK-AAAA-1111',
    machineName: 'Desktop Alpha',
    defaultParent: process.cwd(),
  });

  const engineB = new LanDiscoveryEngine({
    machineToken: 'WK-BBBB-2222',
    machineName: 'Laptop Beta',
    defaultParent: process.cwd(),
  });

  const infoA = await engineA.start();
  const infoB = await engineB.start();

  assert.ok(infoA.httpPort > 0);
  assert.ok(infoB.httpPort > 0);
  assert.equal(infoA.pin.length, 6);

  // Simulate Engine B discovering Engine A
  engineB.discoveredPeers.set('WK-AAAA-1111', {
    token: 'WK-AAAA-1111',
    name: 'Desktop Alpha',
    ip: '127.0.0.1',
    port: infoA.httpPort,
    paired: false,
    lastSeen: Date.now(),
  });

  // Pairing with wrong PIN fails
  await assert.rejects(
    () => engineB.pairWithPeer('WK-AAAA-1111', '000000'),
    /INVALID_OR_EXPIRED_PIN/
  );

  // Pairing with correct PIN succeeds
  const pairResult = await engineB.pairWithPeer('WK-AAAA-1111', infoA.pin);
  assert.equal(pairResult.ok, true);
  assert.equal(pairResult.peerToken, 'WK-AAAA-1111');
  assert.equal(engineA.pairedPeers.has('WK-BBBB-2222'), true);

  // Direct manual pairing test (dsh-go fallback pattern)
  const directResult = await engineB.pairDirect(`127.0.0.1:${infoA.httpPort}`, infoA.pin);
  assert.equal(directResult.ok, true);
  assert.equal(directResult.ip, '127.0.0.1');
  assert.equal(directResult.port, infoA.httpPort);

  // Pair link test
  const link = engineA.getPairLink();
  assert.ok(link.startsWith('work://pair?'));
  assert.ok(link.includes(`pin=${infoA.pin}`));

  // Status check: PIN TTL is 5 minutes (300,000 ms)
  const statusA = engineA.getStatus();
  assert.equal(statusA.pinTtl, 5 * 60 * 1000);
  assert.ok(statusA.pinExpiresAt > Date.now());
  assert.ok(statusA.pinExpiresAt <= Date.now() + 5 * 60 * 1000);

  // refreshPin regenerates 6-digit PIN and resets 5-minute TTL
  const prevPin = engineA.currentPin;
  const newPin = engineA.refreshPin();
  assert.equal(typeof newPin, 'string');
  assert.equal(newPin.length, 6);
  assert.ok(engineA.pinExpiresAt > Date.now() + 4 * 60 * 1000);

  // Expired PIN rejection test
  engineA.pinExpiresAt = Date.now() - 1000;
  await assert.rejects(
    () => engineB.pairWithPeer('WK-AAAA-1111', newPin),
    /INVALID_OR_EXPIRED_PIN/
  );
  engineA.refreshPin();

  // Protected endpoint /p2p/repo-archive: Unpaired peer gets 401
  const unauthRes = await fetch(`http://127.0.0.1:${infoA.httpPort}/p2p/repo-archive?repo=test-repo`);
  assert.equal(unauthRes.status, 401);
  const unauthJson = await unauthRes.json();
  assert.equal(unauthJson.ok, false);
  assert.equal(unauthJson.error, 'UNPAIRED_WORKSTATION');

  // Paired peer with valid X-Machine-Token and X-Pair-Secret passes 401 gate
  const authSecret = engineA.pairSecrets.get('WK-BBBB-2222');
  assert.ok(authSecret);
  const authRes = await fetch(`http://127.0.0.1:${infoA.httpPort}/p2p/repo-archive?repo=nonexistent-repo`, {
    headers: {
      'x-machine-token': 'WK-BBBB-2222',
      'x-pair-secret': authSecret,
    },
  });
  // 404 indicates auth passed, but repo folder does not exist
  assert.equal(authRes.status, 404);

  // Protected Git Smart HTTP endpoint: Unpaired gets 401
  const gitUnauthRes = await fetch(`http://127.0.0.1:${infoA.httpPort}/p2p/git-upload-pack?repo=test-repo`);
  assert.equal(gitUnauthRes.status, 401);

  // Paired peer passes auth to Git Smart HTTP endpoint
  const gitAuthRes = await fetch(`http://127.0.0.1:${infoA.httpPort}/p2p/git-upload-pack?repo=nonexistent-repo`, {
    headers: {
      'x-machine-token': 'WK-BBBB-2222',
      'x-pair-secret': authSecret,
    },
  });
  assert.equal(gitAuthRes.status, 404);

  // UDP broadcastUpdate triggers onPeerMessage on receiving peer
  let updateReceived = null;
  engineB.onPeerMessage = (msg) => {
    if (msg.type === 'work_update_available') {
      updateReceived = msg;
    }
  };

  engineA.broadcastUpdate({
    version: '4.7.0',
    assetId: 99999,
    downloadUrl: 'https://example.com/work-4.7.0.zip',
    publishedAt: new Date().toISOString(),
  });

  // Give UDP loopback time to arrive
  await new Promise(r => setTimeout(r, 100));
  assert.ok(updateReceived);
  assert.equal(updateReceived.version, '4.7.0');
  assert.equal(updateReceived.assetId, 99999);

  await engineA.stop();
  await engineB.stop();
});
