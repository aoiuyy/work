/**
 * Music RPC handlers backed by BravePlayer.
 */
export function createMusicRoutes(musicPlayer) {
  return {
    musicStatus: async () => ({ ok: true, value: musicPlayer.status() }),
    musicPrewarm: async () => ({ ok: true, value: await musicPlayer.prewarm() }),
    musicSearch: async (args) => ({ ok: true, value: await musicPlayer.search(args.query, args.filters) }),
    musicBrowse: async (args) => ({ ok: true, value: await musicPlayer.browse(args) }),
    musicPlay: async (args) => {
      const res = await musicPlayer.play(args.urlOrId, { loop: args.loop, mode: args.mode });
      if (res?.stale) return { ok: true, value: res };
      return res?.ok === false
        ? { ok: false, error: { message: res.fallbackError || 'Playback unavailable' } }
        : { ok: true, value: res };
    },
    musicCommand: async (args) => ({ ok: true, value: await musicPlayer.command(args.command, args.value, args.mode) }),
    musicState: async () => ({ ok: true, value: await musicPlayer.readState() }),
    musicStop: async () => ({ ok: true, value: await musicPlayer.stop() }),
    musicGetPlaylist: async () => ({ ok: true, value: await musicPlayer.loadPlaylist() }),
    musicSavePlaylist: async (args) => ({ ok: true, value: { saved: await musicPlayer.savePlaylist(args.playlist) } }),
    musicVideoMode: async (args) => ({ ok: true, value: await musicPlayer.setVideoMode(Boolean(args?.enabled)) }),
    musicVideoFrame: async () => ({ ok: true, value: await musicPlayer.getVideoFrame() }),
    musicVideoInput: async (args) => ({ ok: true, value: await musicPlayer.videoInput(args) }),
    musicHome: async () => ({ ok: true, value: await musicPlayer.homeFeed() }),
  };
}
