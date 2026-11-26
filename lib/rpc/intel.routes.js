/**
 * Intel Live Browser RPC handlers backed by IntelBrowser CDP.
 */
export function createIntelRoutes(intelBrowser = null) {
  const noBrowser = () => ({ ok: false, error: { code: 'BROWSER_UNAVAILABLE', message: 'Intel Live Browser unavailable' } });
  return {
    intelBrowserStatus: async () => (intelBrowser ? { ok: true, value: intelBrowser.status() } : noBrowser()),
    intelBrowserNavigate: async (args) => (intelBrowser ? { ok: true, value: await intelBrowser.navigate(args.url) } : noBrowser()),
    intelBrowserSnapshot: async () => (intelBrowser ? { ok: true, value: await intelBrowser.snapshot() } : noBrowser()),
    intelBrowserInput: async (args) => (intelBrowser ? { ok: true, value: await intelBrowser.input(args) } : noBrowser()),
    intelBrowserResize: async (args) => (intelBrowser ? { ok: true, value: await intelBrowser.resize(args.width, args.height) } : noBrowser()),
    intelBrowserDarkMode: async (args) => (intelBrowser ? { ok: true, value: await intelBrowser.applyDarkMode(args.enabled) } : noBrowser()),
    intelBrowserClip: async () => (intelBrowser ? { ok: true, value: await intelBrowser.clipPage() } : noBrowser()),
    intelBrowserStop: async () => (intelBrowser ? { ok: true, value: await intelBrowser.stop() } : noBrowser()),
  };
}
