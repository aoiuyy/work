import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as githubClient from './lib/engines/github-client.js';
import * as zipExtractor from './lib/engines/zip-extractor.js';
import * as vault from './lib/engines/dpapi-vault.js';
import * as publisher from './lib/engines/publisher.js';
import * as gitEngine from './lib/engines/git-engine.js';
import * as workUpdates from './lib/engines/work-updates.js';
import { parseChatCommand, validateRoomId } from './lib/engines/chat-command.js';
import { LanDiscoveryEngine } from './lib/engines/lan-discovery.js';
import { BravePlayer } from './lib/engines/brave-player.js';
import { IntelBrowser } from './lib/engines/intel-browser.js';
import { RealtimeRelayBus } from './lib/engines/realtime-relay.js';
import { MASTER_VAULT, createPeerDirectory } from './lib/engines/peer-directory.js';
import { createAuthProfileService } from './lib/services/auth-profile.js';
import { createAttachmentStore } from './lib/services/attachment-store.js';
import { createMessageCache } from './lib/services/message-cache.js';
import { RustSidecarManager } from './lib/services/rust-sidecar.js';
import { createQuickRunner, pickNativePathWindows } from './lib/services/quick-runner.js';
import { createLanBridge } from './lib/services/lan-bridge.js';
import { createChatRoutes } from './lib/rpc/chat.routes.js';
import { createGitRoutes } from './lib/rpc/git.routes.js';
import { createLanRoutes } from './lib/rpc/lan.routes.js';
import { createMusicRoutes } from './lib/rpc/music.routes.js';
import { createIntelRoutes } from './lib/rpc/intel.routes.js';
import { createSystemRoutes } from './lib/rpc/system.routes.js';
import { registerWorkRouter } from './lib/rpc/router.js';

export { parseChatCommand } from './lib/engines/chat-command.js';
export const inject = ['connection'];

const DEFAULT_PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Host entry point for Work plugin (@local/work-v2).
 * Wires domain services and registers '/api/work/*' Fetch routes on Cordis connection.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @param {object} overrides Optional dependency overrides for isolated testing.
 */
export function apply(ctx, config = {}, overrides = {}) {
  const pluginDir = overrides.pluginDir || DEFAULT_PLUGIN_DIR;
  const dataDir = overrides.dataDir || path.join(pluginDir, 'data');

  const deps = {
    vault: overrides.vault || vault,
    githubClient: overrides.githubClient || githubClient,
    gitEngine: overrides.gitEngine || gitEngine,
    publisher: overrides.publisher || publisher,
    zipExtractor: overrides.zipExtractor || zipExtractor,
    workUpdates: overrides.workUpdates || workUpdates,
    LanDiscoveryEngine: overrides.LanDiscoveryEngine || LanDiscoveryEngine,
  };

  const cfg = {
    defaultParent: config.defaultParent || '',
    vaultRepo: config.vaultRepo || 'dsh-work-vault',
    machineName: config.machineName || 'Workstation',
    showBubble: config.showBubble !== false,
  };

  deps.vault.readWorkConfig().then(saved => {
    if (saved?.vaultRepo) cfg.vaultRepo = saved.vaultRepo;
    if (saved?.machineName) cfg.machineName = saved.machineName;
    if (saved?.defaultParent) cfg.defaultParent = saved.defaultParent;
    if (typeof saved?.showBubble === 'boolean') cfg.showBubble = saved.showBubble;
  }).catch(() => {});

  const { getStoredGithubAuth, ensureMachineProfile } = createAuthProfileService({
    cfg,
    vault: deps.vault,
    stableMachineId: deps.publisher.stableMachineId,
  });
  const attachmentStore = createAttachmentStore(dataDir);
  const messageCache = createMessageCache(dataDir);
  const quickRunner = createQuickRunner();
  const peerDirectory = overrides.peerDirectory || createPeerDirectory();
  const rustSidecar = overrides.rustSidecar || new RustSidecarManager(pluginDir);
  const musicPlayer = overrides.musicPlayer || new BravePlayer();
  const intelBrowser = overrides.intelBrowser || new IntelBrowser();
  const dirtyRoomsFromRelay = new Set();
  let latestRelayUpdate = null;

  const realtimeRelay = overrides.realtimeRelay || new RealtimeRelayBus({
    disabled: overrides.disableRelay === true || process.env.WORK_DISABLE_RELAY === '1',
    onEvent: async (evt) => {
      try {
        if (evt?.type === 'work-update' && evt.version) {
          latestRelayUpdate = { version: evt.version, assetId: evt.assetId || null, downloadUrl: evt.downloadUrl || null, receivedAt: Date.now() };
          return;
        }
        if (!evt?.roomId) return;
        const rId = validateRoomId(evt.roomId);
        if (evt.type === 'sync-hint') {
          dirtyRoomsFromRelay.add(rId);
          return;
        }
        if (evt.type === 'chat-event' && evt.message) {
          const cache = await messageCache.loadPersistentCache();
          cache.rooms ||= {};
          const room = cache.rooms[rId] ||= { issueNumber: null, lastEtag: null, since: null, messages: [] };
          if (evt.action === 'deleteChatMessage') {
            const target = room.messages.find(x => x.id === evt.message.id);
            const before = room.messages.length;
            room.messages = room.messages.filter(x => x.id !== evt.message.id);
            room.deletedIds = [...new Set([...(room.deletedIds || []), evt.message.id])].slice(-200);
            if (room.messages.length !== before) await messageCache.savePersistentCache(cache);
            if (target?.fileMeta?.filePath) {
              try {
                const safePath = await attachmentStore.confinedAttachment(target.fileMeta.filePath);
                await (await import('node:fs/promises')).default.unlink(safePath).catch(() => {});
              } catch {}
            }
            return;
          }
          if (['editChatMessage', 'pinChatMessage', 'reactChatMessage'].includes(evt.action)) {
            const idx = room.messages.findIndex(x => x.id === evt.message.id);
            if (idx >= 0) {
              room.messages[idx] = evt.message;
              await messageCache.savePersistentCache(cache);
            }
            return;
          }
          const m = { ...evt.message, fileMeta: evt.message.fileMeta ? { ...evt.message.fileMeta } : null };
          if (m.fileMeta?.rawBase64) {
            const raw = m.fileMeta.rawBase64;
            delete m.fileMeta.filePath;
            delete m.fileMeta.storedLocally;
            delete m.fileMeta.audioUrl;
            delete m.fileMeta.dataUrl;
            delete m.fileMeta.rawBase64;
            m.fileMeta = await attachmentStore.storeAttachment(m.fileMeta, attachmentStore.decodeAttachment(raw), m.type);
          }
          if (!room.messages.some(x => x.id === m.id)) {
            room.messages.push(m);
            room.messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            await messageCache.savePersistentCache(cache);
          }
        }
      } catch {}
    },
  });

  const lanBridge = createLanBridge({
    cfg,
    ensureMachineProfile,
    attachmentStore,
    messageCache,
    vault: deps.vault,
    LanDiscoveryEngine: deps.LanDiscoveryEngine,
    validateRoomId,
  });

  ensureMachineProfile()
    .then(async (profile) => {
      const ghAuth = await getStoredGithubAuth().catch(() => null);
      if (ghAuth?.token) realtimeRelay.subscribeRoom('work-updates', 'aoiuyy/work');
      const lan = await lanBridge.getLanEngine().catch(() => null);
      await rustSidecar.start({
        machineToken: profile.machineToken,
        machineName: profile.machineName,
        httpPort: lan?.httpPort || 0,
      });
    })
    .catch(() => {});

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', async () => {
      await realtimeRelay.stop().catch(() => {});
      await lanBridge.stop().catch(() => {});
      await musicPlayer.stop().catch(() => {});
      await intelBrowser.stop().catch(() => {});
      await rustSidecar.stop().catch(() => {});
    });
  }

  const handlers = {
    ...createLanRoutes({
      cfg,
      getLanEngine: lanBridge.getLanEngine,
      ensureMachineProfile,
      peerDirectory,
      rustSidecar,
      vault: deps.vault,
      publisher: deps.publisher,
    }),
    ...createSystemRoutes({
      ctx,
      cfg,
      pluginDir,
      getStoredGithubAuth,
      ensureMachineProfile,
      githubClient: deps.githubClient,
      vault: deps.vault,
      publisher: deps.publisher,
      zipExtractor: deps.zipExtractor,
      workUpdates: deps.workUpdates,
      quickRunner,
      pickNativePathWindows,
      getLanEngine: lanBridge.getLanEngine,
      getLatestLanUpdate: lanBridge.getLatestUpdate,
      getLatestRelayUpdate: () => latestRelayUpdate,
      masterVault: MASTER_VAULT,
      realtimeRelay,
    }),
    ...createChatRoutes({
      cfg,
      getStoredGithubAuth,
      ensureMachineProfile,
      messageCache,
      attachmentStore,
      getLanEngine: lanBridge.getLanEngine,
      githubClient: deps.githubClient,
      gitEngine: deps.gitEngine,
      publisher: deps.publisher,
      parseChatCommand,
      validateRoomId,
      realtimeRelay,
      dirtyRoomsFromRelay,
      masterVault: MASTER_VAULT,
    }),
    ...createGitRoutes({
      cfg,
      getStoredGithubAuth,
      ensureMachineProfile,
      gitEngine: deps.gitEngine,
      githubClient: deps.githubClient,
      vault: deps.vault,
      messageCache,
      publisher: deps.publisher,
      validateRoomId,
      realtimeRelay,
    }),
    ...createMusicRoutes(musicPlayer),
    ...createIntelRoutes(intelBrowser),
  };

  registerWorkRouter(ctx, handlers, {
    getStoredGithubAuth,
    redactGitError: deps.gitEngine.redactGitError,
  });
}
