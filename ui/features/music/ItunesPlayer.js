    // --- Streamlined Mini Audio Strip & Popover (Discord/Spotify style) ---
    async function runPlayerAction(rpc, action, args, reportError, silent = false) {
      try {
        const result = await rpc(action, args);
        if (!result?.ok) throw new Error(result?.error?.message || 'Music request failed');
        return result;
      } catch (error) {
        if (!silent) reportError(`${action}: ${error?.message || 'Music connection failed'}. Retry the control.`);
        return { ok: false };
      }
    }
    function ItunesPlayer({ connection, popoverOpen, setPopoverOpen, musicActive = false, onOpenSearch }) {
      const [playerError, setPlayerError] = useState('');
      const mounted = useRef(true);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const playerAction = useCallback((action, args = {}, opts = {}) => runPlayerAction(
        (method, payload) => callWorkRpc(connection, method, payload), action, args,
        error => { if (mounted.current) setPlayerError(error); },
        opts.silent
      ), [connection]);
      const [playerState, setPlayerState] = useState(null);
      const [playlist, setPlaylist] = useState([]);
      const [volume, setVolume] = useState(0.8);
      const [loop, setLoop] = useState(false);
      const [replayMode, setReplayMode] = useState(0); // 0: off, 1: repeat-one, 2: repeat-all
      const [shuffle, setShuffle] = useState(false);
      const [playbackRate, setPlaybackRate] = useState(1);
      const [activeTab, setActiveTab] = useState('player');
      const [searchQuery, setSearchQuery] = useState('');
      const [hasSearched, setHasSearched] = useState(false);
      const [searching, setSearching] = useState(false);
      const [searchResults, setSearchResults] = useState([]);
      const [searchFilters, setSearchFilters] = useState({ type: 'all', uploadDate: 'any', duration: 'any', sortBy: 'relevance' });
      const [filtersOpen, setFiltersOpen] = useState(false);
      const [browseState, setBrowseState] = useState(null);
      const [scrubbingTime, setScrubbingTime] = useState(null);
      const [displayTime, setDisplayTime] = useState(0);
      const [audioOnly, setAudioOnly] = useState(false);
      const [videoFrame, setVideoFrame] = useState(null);
      const [copiedNotice, setCopiedNotice] = useState(false);
      const initialSplitPct = (() => {
        try {
          const saved = Number(typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_work_music_split_pct') : 52);
          return Number.isFinite(saved) && saved >= 34 && saved <= 76 ? saved : 52;
        } catch { return 52; }
      })();
      const [splitPct, setSplitPct] = useState(initialSplitPct);
      const footerRef = useRef(null);
      const splitContainerRef = useRef(null);
      const splitDragRef = useRef(null);
      const videoImgRef = useRef(null);
      const lastHoverAtRef = useRef(0);
      const homeLoadedRef = useRef(false);
      const prewarmStartedRef = useRef(false);
      const searchSequence = useRef(0);
      const browseSequence = useRef(0);
      const previousVolume = useRef(0.8);
      const progressAnchor = useRef({ time: 0, at: 0, playing: false, duration: 0 });
      useEffect(() => {
        let frame;
        const tick = () => {
          const anchor = progressAnchor.current;
          const time = anchor.time + (anchor.playing ? Math.max(0, performance.now() - anchor.at) / 1000 : 0);
          setDisplayTime(anchor.duration > 0 ? Math.min(time, anchor.duration) : time);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
      }, []);
      const togglePlayback = async () => {
        const wasPlaying = Boolean(playerState?.playing);
        setPlayerState(state => ({ ...state, playing: !wasPlaying }));
        progressAnchor.current = { ...progressAnchor.current, time: displayTime, at: performance.now(), playing: !wasPlaying };
        const res = await playerAction('musicCommand', { command: wasPlaying ? 'pause' : 'play' });
        if (!res.ok) {
          setPlayerState(state => ({ ...state, playing: wasPlaying }));
          progressAnchor.current = { ...progressAnchor.current, playing: wasPlaying };
        }
      };
      const toggleMute = async () => {
        const muted = playerState?.muted || volume === 0;
        if (!muted && volume > 0) previousVolume.current = volume;
        const next = muted ? previousVolume.current || 0.8 : 0;
        const res = await playerAction('musicCommand', { command: 'volume', value: next });
        if (res.ok) { setVolume(next); setPlayerState(state => ({ ...state, muted: next === 0 })); }
      };
      const commitSeek = async value => {
        const res = await playerAction('musicCommand', { command: 'seek', value });
        if (res.ok) { progressAnchor.current = { ...progressAnchor.current, time: value, at: performance.now() }; setDisplayTime(value); }
        setScrubbingTime(null);
      };

      useEffect(() => {
        let cancelled = false;
        let pending = false;
        const poll = async () => {
          if (pending) return;
          pending = true;
          try {
            const res = await playerAction('musicState', {}, { silent: true });
            if (!cancelled && res?.ok && res.value) {
              setPlayerState(res.value);
              progressAnchor.current = { time: res.value.currentTime || 0, at: performance.now(), playing: res.value.playing && !res.value.buffering, duration: res.value.duration || 0 };
              if (typeof res.value.volume === 'number') setVolume(res.value.volume);
              if (typeof res.value.loop === 'boolean') setLoop(res.value.loop);
              if (res.value.replayMode) setReplayMode(res.value.replayMode === 'one' ? 1 : res.value.replayMode === 'all' ? 2 : 0);
              if (typeof res.value.shuffle === 'boolean') setShuffle(res.value.shuffle);
              if (typeof res.value.playbackRate === 'number' && res.value.playbackRate > 0) setPlaybackRate(res.value.playbackRate);
            }
          } finally { pending = false; }
        };
        poll();
        const interval = setInterval(poll, 1200);
        return () => { cancelled = true; clearInterval(interval); };
      }, [connection, playerAction]);

      useEffect(() => {
        playerAction('musicGetPlaylist', {}, { silent: true }).then((res) => {
          if (res?.ok && Array.isArray(res.value)) setPlaylist(res.value);
        });
      }, [connection, playerAction]);

      const playTrack = async (track) => {
        setAudioOnly(false);
        const res = await playerAction('musicPlay', { urlOrId: track.url || track.id, loop: replayMode === 1, mode: ['off', 'one', 'all'][replayMode] });
        if (res.ok && !res.value?.stale) setPlayerError('');
      };

      const stepQueue = async (delta) => {
        await playerAction('musicCommand', { command: delta > 0 ? 'next' : 'previous' });
      };

      const handleVolumeChange = async (e) => {
        const v = Number(e.target.value);
        const res = await playerAction('musicCommand', { command: 'volume', value: v });
        if (res.ok) { setVolume(v); if (v > 0) previousVolume.current = v; setPlayerState(state => ({ ...state, muted: v === 0 })); }
      };

      const handleToggleReplay = async () => {
        const nextMode = (replayMode + 1) % 3;
        const res = await playerAction('musicCommand', { command: 'loop', value: nextMode === 1, mode: ['off', 'one', 'all'][nextMode] });
        if (res.ok) { setReplayMode(nextMode); setLoop(nextMode === 1); }
      };

      const handleToggleShuffle = async () => {
        const next = !shuffle;
        const res = await playerAction('musicCommand', { command: 'shuffle', value: next });
        if (res.ok) setShuffle(next);
      };

      const handleCycleRate = async () => {
        const steps = [1, 1.25, 1.5, 2];
        const idx = steps.indexOf(playbackRate);
        const next = steps[(idx + 1) % steps.length];
        const res = await playerAction('musicCommand', { command: 'rate', value: next });
        if (res.ok) setPlaybackRate(next);
      };

      const runSearch = async (queryText, nextFilters) => {
        const q = (queryText ?? searchQuery).trim();
        const filters = nextFilters || searchFilters;
        setBrowseState(null);
        if (!q) {
          setHasSearched(false);
          const home = await playerAction('musicHome', {}, { silent: true });
          if (home?.ok && Array.isArray(home.value)) setSearchResults(home.value);
          return;
        }
        setSearchQuery(q);
        setHasSearched(true);
        const sequence = ++searchSequence.current;
        setSearching(true);
        try {
          const res = await playerAction('musicSearch', { query: q, filters });
          if (sequence === searchSequence.current && res?.ok && Array.isArray(res.value)) setSearchResults(res.value);
        } finally {
          if (sequence === searchSequence.current) setSearching(false);
        }
      };

      const updateSearchFilter = (patch) => {
        const next = { ...searchFilters, ...patch };
        if (next.type === 'channel' || next.type === 'playlist') {
          next.uploadDate = 'any';
          next.duration = 'any';
        }
        setSearchFilters(next);
        if (searchQuery.trim()) runSearch(searchQuery, next);
      };

      const openBrowseCard = async (item) => {
        const seq = ++browseSequence.current;
        setBrowseState({ kind: item.type, title: item.title, subtitle: item.handle || item.author || '', items: [], loading: true });
        const res = await playerAction('musicBrowse', {
          kind: item.type,
          pathOrId: item.type === 'channel' ? item.channelPath : item.id,
          title: item.title,
        }, { silent: true });
        if (seq !== browseSequence.current || !mounted.current) return;
        setBrowseState({
          kind: item.type,
          title: item.title,
          subtitle: item.handle || item.author || '',
          items: (res?.ok && Array.isArray(res.value)) ? res.value : [],
          loading: false,
        });
      };

      useEffect(() => {
        if (!musicActive) return;
        if (!prewarmStartedRef.current) {
          prewarmStartedRef.current = true;
          playerAction('musicPrewarm', {}, { silent: true });
        }
        if (homeLoadedRef.current || searchQuery.trim() || searchResults.length > 0) return;
        homeLoadedRef.current = true;
        playerAction('musicHome', {}, { silent: true }).then(res => {
          if (mounted.current && res?.ok && Array.isArray(res.value) && res.value.length > 0) {
            setSearchResults(res.value);
          }
        });
      }, [musicActive, playerAction]);

      const playerStateRef = useRef(playerState);
      playerStateRef.current = playerState;
      const musicActiveRef = useRef(musicActive);
      musicActiveRef.current = musicActive;
      const togglePlaybackRef = useRef(togglePlayback);
      togglePlaybackRef.current = togglePlayback;
      const commitSeekRef = useRef(commitSeek);
      commitSeekRef.current = commitSeek;

      useEffect(() => {
        if (typeof window === 'undefined') return;
        const onKeyDown = (e) => {
          if (!musicActiveRef.current || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
          if (footerRef.current && typeof footerRef.current.getClientRects === 'function' && footerRef.current.getClientRects().length === 0) return;
          const target = e.target;
          const tag = target?.tagName;
          if (target?.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && target.type !== 'range')) return;
          if (e.code === 'Space' || e.key === ' ') {
            e.preventDefault();
            togglePlaybackRef.current();
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            if (tag === 'INPUT' && target.type === 'range' && target.classList?.contains('wk-volume-slider')) return;
            const st = playerStateRef.current;
            if (!st?.duration || st.isLive) return;
            e.preventDefault();
            const delta = e.key === 'ArrowRight' ? 5 : -5;
            const anchor = progressAnchor.current;
            const cur = anchor.time + (anchor.playing ? Math.max(0, performance.now() - anchor.at) / 1000 : 0);
            const next = Math.max(0, Math.min(st.duration, Math.round((cur + delta) * 10) / 10));
            progressAnchor.current = { ...anchor, time: next, at: performance.now() };
            setDisplayTime(next);
            commitSeekRef.current(next);
          }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, []);

      const sendVideoPointer = (type, e) => {
        const el = videoImgRef.current;
        if (!el || !playerState?.ready) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.round(((e.clientX - rect.left) / rect.width) * 1280);
        const y = Math.round(((e.clientY - rect.top) / rect.height) * 720);
        if (type === 'move') {
          const now = Date.now();
          if (now - lastHoverAtRef.current < 120) return;
          lastHoverAtRef.current = now;
        }
        playerAction('musicVideoInput', { type, x, y }, { silent: true }).then(res => {
          if (mounted.current && res?.ok && res.value?.frame) setVideoFrame(res.value.frame);
        });
      };

      useEffect(() => {
        if (!musicActive || audioOnly) {
          setVideoFrame(null);
          playerAction('musicVideoMode', { enabled: false }, { silent: true });
          return;
        }
        playerAction('musicVideoMode', { enabled: true }, { silent: true });
        return () => {
          playerAction('musicVideoMode', { enabled: false }, { silent: true });
        };
      }, [musicActive, audioOnly, playerAction]);

      useEffect(() => {
        if (!musicActive || audioOnly) return;
        let cancelled = false;
        let inFlight = false;
        let timer = null;
        const pullFrame = async () => {
          if (cancelled) return;
          const st = playerStateRef.current;
          if (!document.hidden && !inFlight && (st?.ready || st?.videoId || st?.url)) {
            inFlight = true;
            try {
              const res = await playerAction('musicVideoFrame', {}, { silent: true });
              if (!cancelled && res?.ok && res.value?.frame) setVideoFrame(res.value.frame);
            } finally { inFlight = false; }
          }
          if (!cancelled) {
            const stNext = playerStateRef.current;
            const delay = document.hidden ? 1500 : stNext?.playing ? 50 : 250;
            timer = setTimeout(pullFrame, delay);
          }
        };
        pullFrame();
        return () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        };
      }, [musicActive, audioOnly, playerAction]);

      const beginSplitDrag = (e) => {
        if (e.button !== 0 || !splitContainerRef.current) return;
        e.preventDefault();
        splitDragRef.current = e.pointerId;
        e.currentTarget.setPointerCapture?.(e.pointerId);
      };
      const moveSplitDrag = (e) => {
        if (splitDragRef.current !== e.pointerId || !splitContainerRef.current) return;
        const rect = splitContainerRef.current.getBoundingClientRect();
        if (!rect.width) return;
        const pct = Math.max(34, Math.min(76, Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10));
        setSplitPct(pct);
      };
      const endSplitDrag = (e) => {
        if (splitDragRef.current !== e.pointerId) return;
        splitDragRef.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_music_split_pct', String(splitPct)); } catch {}
      };

      const copyTrackLink = async () => {
        const link = playerState?.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(playerState.videoId)}` : null;
        if (!link) return;
        try {
          await navigator.clipboard.writeText(link);
          setCopiedNotice(true);
          setTimeout(() => { if (mounted.current) setCopiedNotice(false); }, 1800);
        }
        catch { setPlayerError('Could not copy the track link. Check clipboard permission and retry.'); }
      };

      const stopEngine = async () => {
        const res = await playerAction('musicStop', {});
        if (res.ok) {
          setVideoFrame(null);
          setPlayerState(prev => (prev ? { ...prev, ready: false, playing: false, buffering: false, currentTime: 0 } : null));
          setDisplayTime(0);
          progressAnchor.current = { time: 0, at: performance.now(), playing: false, duration: 0 };
        }
      };

      const persistPlaylist = async (nextList) => {
        const res = await playerAction('musicSavePlaylist', { playlist: nextList });
        if (res.ok && res.value?.saved !== false) { setPlaylist(nextList); return true; }
        setPlayerError('Queue could not be saved. Retry.'); return false;
      };

      const moveQueueItem = async (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= playlist.length) return;
        const next = [...playlist];
        [next[idx], next[target]] = [next[target], next[idx]];
        await persistPlaylist(next);
      };

      const handleAddToPlaylist = async () => {
        if (!playerState?.title) return;
        if (playerState.provider === 'audius') { setPlayerError('This is an Audius alternate. Save the original YouTube track from search instead.'); return; }
        const track = {
          id: playerState.videoId || `track-${Date.now()}`,
          title: playerState.title,
          author: playerState.author || 'YouTube',
          duration: formatTime(playerState.duration || 0),
          thumbnail: playerState.artwork || (playerState.videoId ? `https://i.ytimg.com/vi/${playerState.videoId}/hqdefault.jpg` : ''),
          url: playerState.url || (playerState.videoId ? `https://www.youtube.com/watch?v=${playerState.videoId}` : ''),
        };
        if (playlist.some(t => t.id === track.id || t.title === track.title)) return;
        const next = [...playlist, track];
        await persistPlaylist(next);
      };

      const handleNewPlaylist = async () => {
        await persistPlaylist([]);
      };

      const isPlaying = Boolean(playerState?.playing);
      const compactViews = raw => String(raw || '').replace(/\b(?:views?|watching|lượt xem|người đang xem)\b/gi, '').replace(/\s+/g, ' ').trim();
      const activeExtraFilters = (searchFilters.uploadDate !== 'any' ? 1 : 0) + (searchFilters.duration !== 'any' ? 1 : 0) + (searchFilters.sortBy !== 'relevance' ? 1 : 0);
      const videoFiltersDisabled = searchFilters.type === 'channel' || searchFilters.type === 'playlist';
      const displayedList = browseState ? browseState.items : searchResults;
      const renderResultCard = (r) => {
        if (r.type === 'channel') {
          const subLine = [r.handle, r.subscribers ? `${r.subscribers} subs` : ''].filter(Boolean).join(' · ');
          return h('div', { key: `ch-${r.id}`, className: 'wk-yt-result-card', onClick: () => openBrowseCard(r) }, [
            h('div', { className: 'wk-yt-thumb-wrap is-channel' }, [
              r.thumbnail && h('img', { className: 'wk-yt-thumb', src: r.thumbnail, alt: '', loading: 'lazy' }),
            ]),
            h('div', { className: 'wk-yt-meta' }, [
              h('div', { className: 'wk-yt-title' }, r.title),
              subLine && h('div', { className: 'wk-yt-sub' }, subLine),
            ]),
            h('span', { className: 'wk-yt-type-badge' }, 'Channel'),
          ]);
        }
        if (r.type === 'playlist') {
          return h('div', { key: `pl-${r.id}`, className: 'wk-yt-result-card', onClick: () => openBrowseCard(r) }, [
            h('div', { className: 'wk-yt-thumb-wrap' }, [
              r.thumbnail && h('img', { className: 'wk-yt-thumb', src: r.thumbnail, alt: '', loading: 'lazy' }),
              r.duration && h('span', { className: 'wk-yt-duration' }, r.duration),
            ]),
            h('div', { className: 'wk-yt-meta' }, [
              h('div', { className: 'wk-yt-title' }, r.title),
              h('div', { className: 'wk-yt-sub' }, r.author || 'YouTube'),
            ]),
            h('span', { className: 'wk-yt-type-badge' }, 'Playlist'),
          ]);
        }
        const viewsShort = compactViews(r.views);
        return h('div', { key: r.id, className: 'wk-yt-result-card', onClick: () => playTrack(r) }, [
          h('div', { className: 'wk-yt-thumb-wrap' }, [
            h('img', { className: 'wk-yt-thumb', src: r.thumbnail, alt: '', loading: 'lazy' }),
            r.duration && h('span', { className: 'wk-yt-duration' }, r.duration),
          ]),
          h('div', { className: 'wk-yt-meta' }, [
            h('div', { className: 'wk-yt-title' }, r.title),
            h('div', { className: 'wk-yt-sub' }, r.author || 'YouTube'),
            (viewsShort || r.published) && h('div', { className: 'wk-yt-stats' }, [
              viewsShort && h('span', { className: 'wk-yt-stat-views' }, [
                h(SvgIcon, { path: Icons.Play, size: 10 }),
                h('span', null, viewsShort),
              ]),
              r.published && h('span', null, r.published),
            ]),
          ]),
          h('div', { className: 'wk-yt-acts' }, [
            h('button', {
              className: 'wk-btn wk-btn-secondary wk-btn-sm',
              onClick: e => { e.stopPropagation(); persistPlaylist(playlist.some(item => item.id === r.id) ? playlist : [...playlist, r]); },
              title: 'Add to playlist',
              'aria-label': `Add ${r.title} to queue`,
            }, h(SvgIcon, { path: Icons.Plus, size: 11 })),
          ]),
        ]);
      };

      return h('footer', { ref: footerRef, className: `wk-player-footer ${musicActive ? 'music-active' : ''}`, 'aria-label': 'Music player' }, [
        playerError && h('div', { role: 'alert', className: 'wk-player-error', style: { padding: 8, color: '#fecaca', background: 'var(--wk-elevated)', fontSize: 12 } }, [playerError, h('button', { className: 'wk-btn wk-btn-subtle', onClick: () => setPlayerError(''), 'aria-label': 'Dismiss music error' }, 'Dismiss')]),
        !musicActive && h('div', { className: 'wk-mini-audio-strip' }, [
          h('button', { className: 'wk-mini-audio-info wk-capsule-title', 'aria-label': 'Open Music controls', 'aria-expanded': false, onClick: () => { if (typeof onOpenSearch === 'function') onOpenSearch(); } }, [
            playerState?.artwork ? h('img', { className: 'wk-mini-thumb', src: playerState.artwork, alt: '' }) : h(SvgIcon, { path: Icons.Music, size: 16 }),
            h('span', { className: 'wk-mini-meta' }, [h('span', { className: 'wk-mini-title' }, playerState?.title || 'Music'), playerState?.author && h('span', { className: 'wk-mini-sub' }, playerState.author)]),
          ]),
          h('div', { className: 'wk-capsule-controls' }, [
            h('button', { className: 'wk-btn wk-btn-subtle wk-tooltip-wrap', 'aria-label': 'Previous track', 'data-tooltip': 'Previous', onClick: () => stepQueue(-1) }, h(SvgIcon, { path: Icons.SkipPrev, size: 13 })),
            h('button', { className: 'wk-btn wk-btn-transport-play wk-mini-play-btn wk-tooltip-wrap', 'aria-label': isPlaying ? 'Pause' : 'Play', 'data-tooltip': isPlaying ? 'Pause' : 'Play', onClick: togglePlayback }, h(SvgIcon, { path: isPlaying ? Icons.Pause : Icons.Play, size: 13 })),
            h('button', { className: 'wk-btn wk-btn-subtle wk-tooltip-wrap', 'aria-label': 'Next track', 'data-tooltip': 'Next', onClick: () => stepQueue(1) }, h(SvgIcon, { path: Icons.SkipNext, size: 13 })),
            h('div', { className: 'wk-mini-vol-wrap' }, [
              h('button', {
                type: 'button',
                className: 'wk-btn wk-btn-subtle',
                'aria-label': (playerState?.muted || volume === 0) ? 'Unmute' : 'Mute',
                title: (playerState?.muted || volume === 0) ? 'Unmute' : 'Mute',
                onClick: toggleMute,
              }, h(SvgIcon, { path: (playerState?.muted || volume === 0) ? (Icons.VolumeMuted || Icons.Volume) : Icons.Volume, size: 14 })),
              h('div', { className: 'wk-mini-vol-popover' }, [
                h('input', { className: 'wk-capsule-volume', type: 'range', min: 0, max: 1, step: 0.05, value: volume, 'aria-label': 'Mini player volume', onChange: handleVolumeChange }),
              ]),
            ]),
          ]),
        ]),
        // Full 2-Column Music View (popover disabled over Chats/Repo)
        (musicActive || popoverOpen) && h('div', { className: 'wk-audio-popover wk-player-expanded', 'aria-label': 'Music controls' }, [
          !musicActive && h('div', { className: 'wk-audio-popover-head' }, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
              h(SvgIcon, { path: Icons.Music, size: 13, color: 'var(--wk-text)' }),
              h('span', { style: { fontSize: 12, fontWeight: 700 } }, 'YouTube Audio Engine'),
            ]),
            h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setPopoverOpen(false), 'aria-label': 'Close Music controls' },
              h(SvgIcon, { path: Icons.Close, size: 12 })),
          ]),

          h('div', { className: 'wk-audio-tabs' }, [
            h('button', {
              className: `wk-audio-tab-btn ${activeTab === 'player' ? 'active' : ''}`,
              onClick: () => setActiveTab('player'),
            }, 'Player'),
            h('button', {
              className: `wk-audio-tab-btn ${activeTab === 'search' ? 'active' : ''}`,
              onClick: () => setActiveTab('search'),
            }, 'Search'),
          ]),

          h('div', {
            ref: splitContainerRef,
            className: `wk-music-split ${musicActive ? 'is-two-col' : ''}`,
            style: musicActive ? { '--wk-music-left-pct': `${splitPct}%`, gridTemplateColumns: `minmax(280px, ${splitPct}%) 2px minmax(220px, 1fr)` } : undefined,
          }, [
            (activeTab === 'player' || musicActive) && h('div', { className: 'wk-audio-body wk-music-stage' }, [
              h('section', { className: `wk-music-visual ${audioOnly ? 'is-audio-only' : ''}`, 'aria-label': 'Now playing artwork' }, [
                !audioOnly && videoFrame
                  ? h('img', {
                      ref: videoImgRef,
                      className: 'wk-music-video-frame',
                      src: videoFrame,
                      alt: playerState?.title || 'Live YouTube screen',
                      onMouseMove: e => sendVideoPointer('move', e),
                      onClick: e => sendVideoPointer('click', e),
                    })
                  : audioOnly
                    ? h('div', { className: 'wk-vinyl-stage', onClick: togglePlayback, title: 'Click to Play / Pause' }, [
                        h('div', { className: `wk-vinyl-disc ${isPlaying ? 'is-spinning' : ''}` }, [
                          h('div', { className: 'wk-vinyl-label' },
                            playerState?.artwork
                              ? h('img', { src: playerState.artwork, alt: playerState?.title || 'Track artwork', style: { width: '100%', height: '100%', objectFit: 'cover', transform: 'scale(1.36)' } })
                              : h(SvgIcon, { path: Icons.Music, size: 32 })
                          ),
                          h('span', { className: 'wk-vinyl-spindle', 'aria-hidden': true }),
                        ]),
                      ])
                    : (playerState?.artwork
                        ? h('img', { src: playerState.artwork, alt: playerState?.title || 'Track artwork', onClick: togglePlayback, style: { cursor: 'pointer' } })
                        : h(SvgIcon, { path: Icons.Music, size: 48 })),
                h('div', { className: 'wk-music-visual-actions' }, [
                  h('button', {
                    type: 'button',
                    className: `wk-btn wk-btn-sm ${audioOnly ? 'wk-btn-secondary' : 'wk-btn-subtle'}`,
                    style: audioOnly ? undefined : { background: 'rgba(0,0,0,0.6)', color: '#e6edf3' },
                    'aria-pressed': audioOnly,
                    onClick: () => setAudioOnly(v => !v),
                    title: audioOnly ? 'Switch back to YouTube Video screen' : 'Switch to Audio Only vinyl mode',
                  }, audioOnly ? 'Watch Video' : 'Audio Only'),
                  playerState?.ready && h('button', {
                    type: 'button',
                    className: 'wk-btn wk-btn-subtle wk-btn-sm',
                    style: { background: 'rgba(0,0,0,0.6)', color: '#e6edf3' },
                    onClick: stopEngine,
                    title: 'Stop Brave background engine',
                  }, h(SvgIcon, { path: Icons.Stop, size: 11 })),
                ]),
                playerState?.provider === 'audius' && h('span', { className: 'wk-music-source' }, 'Audius · alternate track'),
              ]),
              (playerState?.error || playerState?.fallbackError) && h('p', { role: 'status', className: 'wk-music-status' }, playerState.error || playerState.fallbackError),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
                playerState?.artwork && h('img', { className: 'wk-mini-thumb', style: { width: 38, height: 38 }, src: playerState.artwork, alt: '' }),
                h('div', { style: { flex: 1, minWidth: 0 } }, [
                  h('div', { style: { fontSize: 13, fontWeight: 650, color: 'var(--wk-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                    playerState?.title || 'No active track'),
                  h('div', { style: { fontSize: 11, color: 'var(--wk-secondary)' } }, playerState?.author || 'Saul Brave CDP'),
                ]),
                playerState?.videoId && h('button', {
                  type: 'button',
                  className: 'wk-btn wk-btn-subtle wk-btn-sm',
                  onClick: copyTrackLink,
                  title: copiedNotice ? 'Copied!' : 'Copy YouTube link',
                  'aria-label': 'Copy track link',
                }, copiedNotice ? 'Copied' : h(SvgIcon, { path: Icons.Link, size: 13 })),
              ]),

              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('input', {
                  type: 'range',
                  min: 0,
                  max: playerState?.duration || 1,
                  step: 1,
                  value: scrubbingTime !== null ? scrubbingTime : Math.min(displayTime, playerState?.duration || 1),
                  disabled: !playerState?.duration || playerState?.isLive,
                  'aria-label': 'Seek in full player',
                  onChange: e => setScrubbingTime(Number(e.target.value)),
                  onPointerCancel: () => setScrubbingTime(null),
                  onPointerUp: e => commitSeek(Number(e.target.value)),
                  onKeyUp: e => {
                    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                      commitSeek(Number(e.target.value));
                    }
                  }
                }),
                h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--wk-secondary)', fontVariantNumeric: 'tabular-nums' } }, [
                  h('span', null, formatTime(scrubbingTime !== null ? scrubbingTime : displayTime)),
                  h('span', null, playerState?.isLive ? 'LIVE' : formatTime(playerState?.duration || 0)),
                ]),
              ]),

              h('div', { className: 'wk-player-controls-wrap' }, [
                h('div', { className: 'wk-transport-dock' }, [
                  h('button', { className: 'wk-btn wk-btn-subtle wk-btn-transport', onClick: handleAddToPlaylist, title: 'Add to playlist', 'aria-label': 'Add to playlist' },
                    h(SvgIcon, { path: Icons.Plus, size: 16 })),
                  h('button', { className: 'wk-btn wk-btn-subtle wk-btn-transport', onClick: () => stepQueue(-1), title: 'Previous', 'aria-label': 'Previous track' },
                    h(SvgIcon, { path: Icons.SkipPrev, size: 17 })),
                  h('button', { className: 'wk-btn wk-btn-primary wk-btn-transport-play', onClick: togglePlayback, title: isPlaying ? 'Pause' : 'Play', 'aria-label': isPlaying ? 'Pause' : 'Play' },
                    h(SvgIcon, { path: isPlaying ? Icons.Pause : Icons.Play, size: 18 })),
                  h('button', { className: 'wk-btn wk-btn-subtle wk-btn-transport', onClick: () => stepQueue(1), title: 'Next', 'aria-label': 'Next track' },
                    h(SvgIcon, { path: Icons.SkipNext, size: 17 })),
                  h('button', { className: `wk-btn wk-btn-subtle wk-btn-transport wk-btn-repeat ${replayMode !== 0 ? 'active' : ''}`, onClick: handleToggleReplay, title: ['Repeat off', 'Repeat one', 'Repeat all'][replayMode], 'aria-label': ['Repeat off', 'Repeat one', 'Repeat all'][replayMode], 'aria-pressed': replayMode !== 0 }, [
                    h(SvgIcon, { path: replayMode === 1 ? (Icons.RepeatOne || Icons.Repeat) : Icons.Repeat, size: 16 }),
                    replayMode !== 0 && h('span', { className: 'wk-repeat-dot', 'aria-hidden': true }),
                  ]),
                  h('button', { className: `wk-btn wk-btn-subtle wk-btn-transport ${shuffle ? 'active' : ''}`, onClick: handleToggleShuffle, title: shuffle ? 'Shuffle on' : 'Shuffle off', 'aria-label': 'Toggle shuffle', 'aria-pressed': shuffle },
                    h(SvgIcon, { path: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5', size: 14 })),
                  h('button', { className: `wk-btn wk-btn-subtle wk-btn-sm ${playbackRate !== 1 ? 'active' : ''}`, style: { minWidth: 34, fontSize: 11, fontVariantNumeric: 'tabular-nums' }, onClick: handleCycleRate, title: 'Playback speed', 'aria-label': `Playback speed ${playbackRate}x` }, `${playbackRate}x`),
                  h('div', { className: 'wk-volume-inline' }, [
                    h('button', { className: 'wk-btn wk-btn-subtle wk-btn-transport', 'aria-label': volume === 0 ? 'Unmute audio' : 'Mute audio', onClick: toggleMute }, h(SvgIcon, { path: Icons.Volume, size: 16 })),
                    h('input', {
                      'aria-label': 'Player volume', type: 'range', min: 0, max: 1, step: 0.05, value: volume,
                      onChange: handleVolumeChange, className: 'wk-volume-slider',
                    }),
                  ]),
                ]),
              ]),

              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--wk-subtle)' } }, [
                h('span', { style: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--wk-secondary)' } }, `Playlist (${playlist.length})`),
                h('div', { style: { display: 'flex', gap: 4 } }, [
                  h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', style: { fontSize: 10, padding: '2px 6px' }, onClick: handleAddToPlaylist, title: 'Add current track to playlist' }, '+ Add current'),
                  h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', style: { fontSize: 10, padding: '2px 6px' }, onClick: handleNewPlaylist, title: 'Clear playlist' }, 'Clear'),
                ]),
              ]),
              h('div', { className: 'wk-queue-list' },
                playlist.length === 0
                  ? h('div', { style: { fontSize: 11, color: 'var(--wk-secondary)', padding: 6 } }, 'Playlist is empty. Search YouTube or pick a preset on the right.')
                  : playlist.map((item, idx) =>
                      h('div', {
                        key: `${item.id}-${idx}`,
                        className: `wk-queue-item ${playerState?.videoId === item.id ? 'active' : ''}`,
                        onClick: () => playTrack(item),
                      }, [
                        h('span', { className: `wk-queue-number ${playerState?.videoId === item.id && isPlaying ? 'wk-now-playing' : ''}`, 'aria-hidden': true }, playerState?.videoId === item.id && isPlaying ? h(SvgIcon, { path: 'M5 9v6M10 4v16M15 7v10M20 10v4', size: 16 }) : String(idx + 1)),
                        item.thumbnail && h('img', { className: 'wk-queue-thumb', src: item.thumbnail, alt: '', loading: 'lazy' }),
                        h('button', { className: 'wk-queue-title wk-btn wk-btn-subtle', 'aria-label': `Play ${item.title}`, onClick: e => { e.stopPropagation(); playTrack(item); } }, item.title),
                        h('span', { className: 'wk-queue-duration' }, item.duration || '--:--'),
                        h('button', {
                          className: 'wk-btn wk-btn-subtle wk-btn-sm', style: { padding: '1px 3px' },
                          'aria-label': `Move ${item.title} up`, disabled: idx === 0,
                          onClick: (e) => { e.stopPropagation(); moveQueueItem(idx, -1); },
                        }, h(SvgIcon, { path: Icons.Up, size: 9 })),
                        h('button', {
                          className: 'wk-btn wk-btn-subtle wk-btn-sm', style: { padding: '1px 3px' },
                          'aria-label': `Move ${item.title} down`, disabled: idx === playlist.length - 1,
                          onClick: (e) => { e.stopPropagation(); moveQueueItem(idx, 1); },
                        }, h(SvgIcon, { path: Icons.Down, size: 9 })),
                        h('button', {
                          className: 'wk-btn wk-btn-subtle wk-btn-sm', style: { padding: '1px 3px' },
                          'aria-label': `Remove ${item.title}`,
                          onClick: (e) => { e.stopPropagation(); persistPlaylist(playlist.filter((_, i) => i !== idx)); },
                        }, h(SvgIcon, { path: Icons.Close, size: 9 })),
                      ])
                    )
              ),
            ]),

            musicActive && h('div', {
              className: 'wk-music-resizer',
              role: 'separator',
              tabIndex: 0,
              'aria-orientation': 'vertical',
              'aria-label': 'Resize video and search columns',
              onPointerDown: beginSplitDrag,
              onPointerMove: moveSplitDrag,
              onPointerUp: endSplitDrag,
              onPointerCancel: endSplitDrag,
              onKeyDown: e => {
                if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitPct(p => Math.max(34, p - 3)); }
                if (e.key === 'ArrowRight') { e.preventDefault(); setSplitPct(p => Math.min(76, p + 3)); }
              },
            }),

            (activeTab === 'search' || musicActive) && h('div', { className: 'wk-music-discovery wk-music-sidebar' }, [
              h('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } }, [
                h('input', {
                  className: 'wk-input',
                  'aria-label': 'Search music or paste YouTube URL',
                  placeholder: 'Search YouTube or paste URL...',
                  value: searchQuery,
                  onChange: e => {
                    const next = e.target.value;
                    setSearchQuery(next);
                    if (!next.trim()) setHasSearched(false);
                  },
                  onKeyDown: e => e.key === 'Enter' && runSearch(),
                }),
                h('button', {
                  className: 'wk-btn wk-btn-primary wk-btn-icon',
                  'aria-label': 'Search music',
                  title: 'Search YouTube',
                  onClick: () => runSearch(),
                  disabled: searching,
                }, h(SvgIcon, { path: searching ? Icons.Refresh : Icons.Search, size: 15, className: searching ? 'wk-spin' : '' })),
              ]),
              !hasSearched && !browseState && h('div', { style: { display: 'flex', gap: 5, flexWrap: 'wrap' } }, [
                h('button', {
                  key: 'You have to lock in',
                  type: 'button',
                  className: 'wk-btn wk-btn-secondary wk-btn-sm',
                  disabled: searching,
                  onClick: () => runSearch('You have to lock in'),
                }, 'You have to lock in'),
              ]),
              !browseState && h('div', { className: 'wk-yt-filter-row', role: 'group', 'aria-label': 'YouTube search filters' }, [
                ...[
                  { id: 'all', label: 'All' },
                  { id: 'video', label: 'Videos' },
                  { id: 'channel', label: 'Channels' },
                  { id: 'playlist', label: 'Playlists' },
                ].map(opt => h('button', {
                  key: opt.id,
                  type: 'button',
                  className: `wk-yt-filter-chip ${searchFilters.type === opt.id ? 'active' : ''}`,
                  'aria-pressed': searchFilters.type === opt.id,
                  onClick: () => updateSearchFilter({ type: opt.id }),
                }, opt.label)),
                h('button', {
                  type: 'button',
                  className: `wk-yt-filter-chip ${filtersOpen || activeExtraFilters > 0 ? 'active' : ''}`,
                  'aria-expanded': filtersOpen,
                  onClick: () => setFiltersOpen(v => !v),
                }, activeExtraFilters > 0 ? `Filters (${activeExtraFilters})` : 'Filters'),
              ]),
              !browseState && filtersOpen && h('div', { className: 'wk-yt-filter-panel' }, [
                h('label', { className: 'wk-yt-filter-group' }, [
                  h('span', { className: 'wk-yt-filter-label' }, 'Upload date'),
                  h('select', {
                    className: 'wk-yt-filter-select',
                    'aria-label': 'Filter by upload date',
                    disabled: videoFiltersDisabled,
                    value: searchFilters.uploadDate,
                    onChange: e => updateSearchFilter({ uploadDate: e.target.value }),
                  }, [
                    h('option', { value: 'any' }, 'Anytime'),
                    h('option', { value: 'hour' }, 'Last hour'),
                    h('option', { value: 'today' }, 'Today'),
                    h('option', { value: 'week' }, 'This week'),
                    h('option', { value: 'month' }, 'This month'),
                    h('option', { value: 'year' }, 'This year'),
                  ]),
                ]),
                h('label', { className: 'wk-yt-filter-group' }, [
                  h('span', { className: 'wk-yt-filter-label' }, 'Duration'),
                  h('select', {
                    className: 'wk-yt-filter-select',
                    'aria-label': 'Filter by duration',
                    disabled: videoFiltersDisabled,
                    value: searchFilters.duration,
                    onChange: e => updateSearchFilter({ duration: e.target.value }),
                  }, [
                    h('option', { value: 'any' }, 'Any'),
                    h('option', { value: 'short' }, '< 4 min'),
                    h('option', { value: 'medium' }, '4 - 20 min'),
                    h('option', { value: 'long' }, '> 20 min'),
                  ]),
                ]),
                h('label', { className: 'wk-yt-filter-group' }, [
                  h('span', { className: 'wk-yt-filter-label' }, 'Sort by'),
                  h('select', {
                    className: 'wk-yt-filter-select',
                    'aria-label': 'Sort search results',
                    value: searchFilters.sortBy,
                    onChange: e => updateSearchFilter({ sortBy: e.target.value }),
                  }, [
                    h('option', { value: 'relevance' }, 'Relevance'),
                    h('option', { value: 'date' }, 'Upload date'),
                    h('option', { value: 'views' }, 'View count'),
                    h('option', { value: 'rating' }, 'Rating'),
                  ]),
                ]),
              ]),
              browseState && h('div', { className: 'wk-yt-browse-bar' }, [
                h('button', {
                  type: 'button',
                  className: 'wk-btn wk-btn-subtle wk-btn-sm',
                  onClick: () => setBrowseState(null),
                  'aria-label': 'Back to search results',
                }, 'Back'),
                h('span', { className: 'wk-yt-browse-title', title: browseState.title }, browseState.title),
                h('span', { className: 'wk-yt-type-badge' }, browseState.kind === 'channel' ? 'Channel' : 'Playlist'),
              ]),
              browseState?.loading
                ? h('div', { className: 'wk-empty-state', style: { padding: '24px 12px' } }, [
                    h(SvgIcon, { path: Icons.Refresh, size: 20, className: 'wk-spin' }),
                    h('p', { className: 'wk-empty-sub', style: { fontSize: 12 } }, `Loading ${browseState.title}...`),
                  ])
                : displayedList.length > 0
                  ? h('div', { className: 'wk-yt-results-grid' }, displayedList.map(renderResultCard))
                  : h('div', { className: 'wk-empty-state', style: { padding: '24px 12px' } }, [
                      h(SvgIcon, { path: Icons.Search, size: 22 }),
                      h('p', { className: 'wk-empty-sub', style: { fontSize: 12 } }, browseState ? 'No videos found in this item.' : 'Type keywords or paste a YouTube URL and press Enter to browse videos.'),
                    ]),
            ]),
          ]),
        ]),
      ]);
    }




