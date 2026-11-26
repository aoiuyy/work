import path from 'node:path';

/**
 * Local Wi-Fi P2P, LAN discovery, and GitHub registry peer handlers.
 */
export function createLanRoutes({
  cfg = {},
  getLanEngine,
  ensureMachineProfile,
  peerDirectory,
  rustSidecar,
  vault,
  publisher,
}) {
  return {
    getLanStatus: async () => {
      const lan = await getLanEngine();
      return {
        ok: true,
        value: {
          localIp: lan.localIp,
          httpPort: lan.httpPort,
          pin: lan.currentPin,
          pinExpiresAt: lan.pinExpiresAt,
          pinTtl: lan.pinTtl,
          pairLink: lan.getPairLink(),
          interfaces: lan.networkCandidates,
          peers: lan.getDiscoveredPeers(),
        },
      };
    },

    refreshLanPin: async () => {
      const lan = await getLanEngine();
      lan.refreshPin();
      return {
        ok: true,
        value: {
          pin: lan.currentPin,
          pinExpiresAt: lan.pinExpiresAt,
          pairLink: lan.getPairLink(),
        },
      };
    },

    pairLanPeer: async (args) => {
      const { peerToken, targetAddress, pin } = args;
      let effectivePin = (pin || '').trim();
      if (!effectivePin && typeof targetAddress === 'string') {
        try {
          const parsed = new URL(targetAddress.replace(/^work:\/\//, 'http://'));
          effectivePin = (parsed.searchParams.get('pin') || '').trim();
        } catch {}
      }
      if ((!peerToken && !targetAddress) || !effectivePin) {
        return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'peerToken or targetAddress and pin required' } };
      }
      const lan = await getLanEngine();
      let pairResult;
      if (targetAddress && targetAddress.startsWith('@')) {
        const handle = targetAddress.slice(1).trim().toLowerCase();
        const matchedPeer = typeof lan.findPeerByHandle === 'function' ? lan.findPeerByHandle(handle) : null;
        if (matchedPeer) {
          pairResult = await lan.pairWithPeer(matchedPeer.token, effectivePin);
        } else {
          return { ok: false, error: { code: 'PEER_NOT_FOUND', message: `Peer @${handle} not found in active discovery` } };
        }
      } else if (targetAddress) {
        pairResult = await lan.pairDirect(targetAddress, effectivePin);
      } else {
        pairResult = await lan.pairWithPeer(peerToken, effectivePin);
      }

      const links = await vault.readPeerLinks().catch(() => []);
      const cleanToken = pairResult.peerToken.trim().toUpperCase();
      const cleanAlias = pairResult.alias || 'LAN Peer';
      const existingIdx = links.findIndex(l => l.peerToken === cleanToken);
      if (existingIdx !== -1) {
        links[existingIdx].alias = cleanAlias;
        links[existingIdx].updatedAt = Date.now();
      } else {
        links.push({ peerToken: cleanToken, alias: cleanAlias, linkedAt: Date.now() });
      }
      await vault.writePeerLinks(links);

      return { ok: true, value: { ...pairResult, links } };
    },

    sendRepoDirectLan: async (args) => {
      const { peerToken, targetPath, toolName, sanitize = true } = args;
      if (!peerToken || !targetPath) {
        return { ok: false, error: { code: 'INVALID_ARGUMENTS', message: 'peerToken and targetPath required' } };
      }
      const lan = await getLanEngine();
      const cleanToolName = (toolName || path.basename(targetPath) || 'transferred-repo').trim();
      const packaged = await publisher.packageProjectToBuffer(targetPath, {
        sanitize,
        trackedOnly: false,
        bundle: true,
      });
      const result = await lan.streamRepoToPeer(peerToken, cleanToolName, packaged.zipBuffer);
      return {
        ok: true,
        value: {
          toolName: cleanToolName,
          meta: packaged.meta,
          tokenCount: packaged.tokenCount,
          targetDir: result.targetDir,
        },
      };
    },

    getDiscoveredLanPeers: async () => {
      const rustPeers = await rustSidecar.call('lan_scan');
      if (Array.isArray(rustPeers)) {
        return { ok: true, value: rustPeers, engine: 'rust' };
      }
      const lan = await getLanEngine();
      return { ok: true, value: lan.getDiscoveredPeers(), engine: 'javascript' };
    },

    getOnlineRegistryPeers: async (_args, signal) => {
      const auth = await vault.readGithubAuth();
      if (!auth?.token) {
        return { ok: false, error: { message: 'Not logged in to GitHub' } };
      }
      const profile = await ensureMachineProfile();
      const users = await peerDirectory.refresh(auth, profile, signal, cfg?.vaultRepo);
      return { ok: true, value: users };
    },
  };
}
