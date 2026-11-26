    // --- Live Browser Intel View ---
    function IntelReaderView({ connection, onBack = null }) {
      const hasDesktopWebview = typeof window !== 'undefined' && typeof window.dshDesktop?.browser?.acquire === 'function';
      const [liveUrl, setLiveUrl] = useState('https://www.facebook.com/');
      const [liveSnapshot, setLiveSnapshot] = useState(null);
      const [liveBusy, setLiveBusy] = useState(false);
      const [liveError, setLiveError] = useState('');
      const [webviewGuest, setWebviewGuest] = useState(null);
      const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false });
      const stageImgRef = useRef(null);
      const viewportRef = useRef(null);
      const webviewRef = useRef(null);
      const webviewInitUrlRef = useRef('https://www.facebook.com/');
      const webviewAttachedRef = useRef(false);
      const liveInFlightRef = useRef(false);
      const lastLiveActivityRef = useRef(Date.now());

      const liveSites = [
        { label: 'Facebook', url: 'https://www.facebook.com/' },
        { label: 'X', url: 'https://x.com/explore' },
        { label: 'Reddit', url: 'https://www.reddit.com/' },
        { label: 'GitHub Trending', url: 'https://github.com/trending' },
      ];

      const markLiveActive = () => { lastLiveActivityRef.current = Date.now(); };

      useEffect(() => {
        if (!hasDesktopWebview) return;
        let cancelled = false;
        let acquiredLease = null;
        let unsubscribeOpen = null;
        window.dshDesktop.browser.acquire('work-intel').then(guest => {
          if (cancelled || !guest?.lease) {
            if (guest?.lease) window.dshDesktop.browser.release(guest.lease).catch(() => {});
            return;
          }
          acquiredLease = guest.lease;
          webviewAttachedRef.current = false;
          setWebviewGuest(guest);
          if (typeof window.dshDesktop.browser.onOpenRequested === 'function') {
            unsubscribeOpen = window.dshDesktop.browser.onOpenRequested(guest.lease, requestedUrl => {
              if (!requestedUrl || /^about:/i.test(requestedUrl)) return;
              webviewInitUrlRef.current = requestedUrl;
              setLiveUrl(requestedUrl);
              try { webviewRef.current?.loadURL?.(requestedUrl); } catch {}
            });
          }
        }).catch(err => {
          if (!cancelled) setLiveError(err?.message || 'Could not initialize native DSH webview.');
        });
        return () => {
          cancelled = true;
          unsubscribeOpen?.();
          webviewAttachedRef.current = false;
          if (acquiredLease) window.dshDesktop.browser.release(acquiredLease).catch(() => {});
        };
      }, [hasDesktopWebview]);

      useEffect(() => {
        if (!hasDesktopWebview || !webviewGuest?.lease) return;
        const wv = webviewRef.current;
        if (!wv) return;
        const syncNav = () => {
          try {
            const url = wv.getURL?.();
            if (url && !/^about:/i.test(url)) setLiveUrl(url);
            setNavState({
              canGoBack: Boolean(wv.canGoBack?.()),
              canGoForward: Boolean(wv.canGoForward?.()),
            });
          } catch {}
        };
        const onDomReady = () => {
          if (!webviewAttachedRef.current) {
            webviewAttachedRef.current = true;
            const target = webviewInitUrlRef.current || 'https://www.facebook.com/';
            try { wv.loadURL?.(target); } catch {}
          }
          syncNav();
        };
        const onStart = () => { setLiveBusy(true); setLiveError(''); };
        const onStop = () => { setLiveBusy(false); syncNav(); };
        const onNav = e => {
          if (e?.url && !/^about:/i.test(e.url)) {
            webviewInitUrlRef.current = e.url;
            setLiveUrl(e.url);
          }
          syncNav();
        };
        const onFail = e => {
          if (e?.errorCode === -3) return;
          setLiveBusy(false);
          if (e?.validatedURL && !/^about:/i.test(e.validatedURL)) {
            setLiveError(e.errorDescription || `Failed to load ${e.validatedURL}`);
          }
        };
        wv.addEventListener('dom-ready', onDomReady);
        wv.addEventListener('did-start-loading', onStart);
        wv.addEventListener('did-stop-loading', onStop);
        wv.addEventListener('did-navigate', onNav);
        wv.addEventListener('did-navigate-in-page', onNav);
        wv.addEventListener('did-fail-load', onFail);
        return () => {
          wv.removeEventListener('dom-ready', onDomReady);
          wv.removeEventListener('did-start-loading', onStart);
          wv.removeEventListener('did-stop-loading', onStop);
          wv.removeEventListener('did-navigate', onNav);
          wv.removeEventListener('did-navigate-in-page', onNav);
          wv.removeEventListener('did-fail-load', onFail);
        };
      }, [hasDesktopWebview, webviewGuest?.lease]);

      const syncViewportSize = async () => {
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width >= 360 && rect.height >= 240) {
          await callWorkRpc(connection, 'intelBrowserResize', { width: Math.floor(rect.width), height: Math.floor(rect.height) }).catch(() => {});
        }
      };

      const navigateLive = async (targetUrl) => {
        const raw = String(targetUrl || liveUrl).trim();
        if (!raw) return;
        const normalized = /^https?:\/\//i.test(raw) ? raw : (/^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]|$)/i.test(raw) ? `https://${raw}` : `https://www.google.com/search?q=${encodeURIComponent(raw)}`);
        setLiveError(''); markLiveActive();
        webviewInitUrlRef.current = normalized;
        setLiveUrl(normalized);
        if (hasDesktopWebview && webviewRef.current) {
          if (webviewAttachedRef.current) {
            try { webviewRef.current.loadURL(normalized); } catch (err) { setLiveError(err?.message || 'Navigation failed'); }
          }
          return;
        }
        setLiveBusy(true);
        try {
          await syncViewportSize();
          const res = await callWorkRpc(connection, 'intelBrowserNavigate', { url: normalized });
          if (!res?.ok) throw new Error(res?.error?.message || 'Could not open site in Brave Live Browser.');
          setLiveSnapshot(res.value);
          if (res.value?.url) setLiveUrl(res.value.url);
        } catch (err) {
          setLiveError(err.message);
        } finally {
          setLiveBusy(false);
        }
      };

      const sendLiveInput = async (payload) => {
        if (hasDesktopWebview && webviewRef.current) {
          try {
            if (payload.type === 'back' && webviewRef.current.canGoBack?.()) webviewRef.current.goBack();
            else if (payload.type === 'forward' && webviewRef.current.canGoForward?.()) webviewRef.current.goForward();
            else if (payload.type === 'reload') webviewRef.current.reload();
          } catch (err) { setLiveError(err?.message || 'Navigation action failed'); }
          return;
        }
        if (!liveSnapshot?.connected && payload.type !== 'reload') return;
        markLiveActive();
        try {
          const res = await callWorkRpc(connection, 'intelBrowserInput', payload);
          if (res?.ok && res.value) {
            setLiveSnapshot(res.value);
            if (res.value.url) setLiveUrl(res.value.url);
          }
        } catch (err) {
          setLiveError(err.message);
        }
      };

      useEffect(() => {
        if (hasDesktopWebview || !viewportRef.current || typeof ResizeObserver !== 'function') return;
        let timer = null;
        const ro = new ResizeObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            if (liveSnapshot?.connected) syncViewportSize();
          }, 220);
        });
        ro.observe(viewportRef.current);
        return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
      }, [hasDesktopWebview, liveSnapshot?.connected, connection]);

      useEffect(() => {
        if (hasDesktopWebview) return;
        let cancelled = false;
        let timer = null;
        const refresh = async (force = false) => {
          if (cancelled) return;
          if (!document.hidden && !liveInFlightRef.current && (force || liveSnapshot?.connected)) {
            liveInFlightRef.current = true;
            try {
              const res = await callWorkRpc(connection, 'intelBrowserSnapshot', {});
              if (!cancelled && res?.ok && res.value?.connected) {
                setLiveSnapshot(res.value);
                if (res.value.url) setLiveUrl(res.value.url);
              }
            } finally { liveInFlightRef.current = false; }
          }
          if (!cancelled) {
            const idleMs = Date.now() - lastLiveActivityRef.current;
            const nextDelay = document.hidden ? 2500 : idleMs < 6000 ? 450 : 1800;
            timer = setTimeout(() => refresh(false), nextDelay);
          }
        };
        refresh(true);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
      }, [hasDesktopWebview, connection, liveSnapshot?.connected]);

      const handleStageClick = e => {
        const img = stageImgRef.current;
        if (!img || !liveSnapshot?.connected) return;
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.round(((e.clientX - rect.left) / rect.width) * (liveSnapshot.width || 1024));
        const y = Math.round(((e.clientY - rect.top) / rect.height) * (liveSnapshot.height || 720));
        e.currentTarget.focus();
        sendLiveInput({ type: 'click', x, y });
      };

      const handleStageWheel = e => {
        if (!liveSnapshot?.connected) return;
        e.preventDefault();
        const img = stageImgRef.current;
        const rect = img?.getBoundingClientRect();
        const x = rect?.width ? Math.round(((e.clientX - rect.left) / rect.width) * (liveSnapshot.width || 1024)) : 512;
        const y = rect?.height ? Math.round(((e.clientY - rect.top) / rect.height) * (liveSnapshot.height || 720)) : 360;
        sendLiveInput({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
      };

      const handleStagePaste = e => {
        if (!liveSnapshot?.connected) return;
        const text = e.clipboardData?.getData('text/plain');
        if (text) {
          e.preventDefault();
          sendLiveInput({ type: 'type', text });
        }
      };

      const handleStageKeyDown = e => {
        if (!liveSnapshot?.connected) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();
          sendLiveInput({ type: 'key', key: e.key });
        } else if (e.key.length === 1) {
          e.preventDefault();
          sendLiveInput({ type: 'type', text: e.key });
        }
      };

      return h('div', { className: 'wk-center-intel-view', 'data-intel-theme': 'oled' }, [
        h('div', { className: 'wk-intel-toolbar' }, [
          h('form', { className: 'wk-intel-omnibox', onSubmit: e => { e.preventDefault(); navigateLive(liveUrl); } }, [
            onBack && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-back', onClick: onBack, 'aria-label': 'Back to conversation list' }, h(SvgIcon, { path: 'M15 18l-6-6 6-6', size: 16 })),
            h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: hasDesktopWebview ? !navState.canGoBack : !liveSnapshot?.connected, onClick: () => sendLiveInput({ type: 'back' }), title: 'Back' }, '<'),
            h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: hasDesktopWebview ? !navState.canGoForward : !liveSnapshot?.connected, onClick: () => sendLiveInput({ type: 'forward' }), title: 'Forward' }, '>'),
            h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: hasDesktopWebview ? !webviewGuest?.lease : !liveSnapshot?.connected, onClick: () => sendLiveInput({ type: 'reload' }), title: 'Reload' }, h(SvgIcon, { path: Icons.Refresh, size: 13 })),
            h('input', { className: 'wk-input', 'aria-label': 'Enter URL or search web', placeholder: 'Enter URL or search web (Enter)...', value: liveUrl, onChange: e => setLiveUrl(e.target.value) }),
          ]),
          h('div', { className: 'wk-intel-filter-row', role: 'group', 'aria-label': 'Social shortcuts' }, [
            ...liveSites.map(site => h('button', {
              key: site.label,
              type: 'button',
              className: `wk-intel-filter-pill ${liveUrl.includes(site.url.replace(/^https?:\/\/(?:www\.)?/, '').split('/')[0]) ? 'active' : ''}`,
              disabled: !hasDesktopWebview && liveBusy,
              onClick: () => navigateLive(site.url),
            }, site.label)),
          ]),
        ]),
        h('div', { className: 'wk-intel-live-wrap' }, [
          liveError && h('div', { className: 'wk-intel-source-status', role: 'alert', style: { color: '#fecaca', padding: '8px 16px' } }, liveError),
          h('div', { ref: viewportRef, className: 'wk-intel-live-viewport' }, [
            hasDesktopWebview
              ? (webviewGuest?.lease
                  ? h('webview', {
                      key: webviewGuest.lease,
                      ref: webviewRef,
                      className: 'wk-intel-webview',
                      src: `about:blank#${webviewGuest.lease}`,
                      partition: webviewGuest.partition,
                    })
                  : h('div', { className: 'wk-empty-state' }, [
                      h('div', { className: 'wk-empty-title' }, 'Live Social Web'),
                      h('p', { className: 'wk-empty-sub' }, 'Starting native browser view...'),
                    ]))
              : (liveSnapshot?.image
                  ? h('div', { className: 'wk-intel-live-stage', tabIndex: 0, onClick: handleStageClick, onWheel: handleStageWheel, onPaste: handleStagePaste, onKeyDown: handleStageKeyDown, 'aria-label': 'Interactive live browser viewport' }, [
                      h('img', { ref: stageImgRef, className: 'wk-intel-live-img', src: liveSnapshot.image, alt: liveSnapshot.title || 'Live social view' }),
                    ])
                  : h('div', { className: 'wk-empty-state' }, [
                      h('div', { className: 'wk-empty-title' }, 'Live Social Web'),
                      h('p', { className: 'wk-empty-sub' }, 'Select a site above or enter a URL and press Enter.'),
                      h('button', { type: 'button', className: 'wk-btn wk-btn-primary', disabled: liveBusy, onClick: () => navigateLive(liveUrl) }, liveBusy ? 'Starting Brave...' : 'Open Facebook'),
                    ])),
          ]),
        ]),
      ]);
    }