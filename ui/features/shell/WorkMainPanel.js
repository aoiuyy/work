    // --- Main Work Panel ---
    function WorkMainPanel({ connection, isEmbedded = false, requestedTab = null }) {
      const initialShared = typeof workSurface !== 'undefined' && workSurface.getState ? workSurface.getState() : {};
      const [auth, setAuth] = useState(null);
      const [profile, setProfile] = useState(null);
      const [peerList, setPeerList] = useState(() => Array.isArray(initialShared.peerList) ? initialShared.peerList : []);
      const [showBubble, setShowBubble] = useState(() => (typeof workSurface !== 'undefined' ? workSurface.bubbleEnabled !== false : true));
      const [realtimeStatus, setRealtimeStatus] = useState(null);
      const [repoOverview, setRepoOverview] = useState(null);
      const [deployments, setDeployments] = useState([]);
      const [selectedDiffFile, setSelectedDiffFile] = useState('');
      const [activePeer, setActivePeerState] = useState(() => initialShared.activePeer || channelPeer('general'));
      const [channels, setChannels] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_work_channels_v1') : null;
          const parsed = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed) && parsed.length) return parsed;
        } catch (_) {}
        return [channelPeer('general')];
      });
      const [workTab, setWorkTabState] = useState(() => requestedTab || initialShared.workTab || (typeof workSurface !== 'undefined' ? workSurface.activeTab : null) || 'messages');
      const [conversationSearch, setConversationSearch] = useState('');
      const [conversationFilter, setConversationFilterState] = useState(() => initialShared.conversationFilter || 'chats');
      const [pendingInvites, setPendingInvites] = useState([]);
      const [workConfig, setWorkConfig] = useState({ machineName: 'Workstation', vaultRepo: 'dsh-work-vault', defaultParent: '' });
      const [savedWorkConfig, setSavedWorkConfig] = useState({ machineName: 'Workstation', vaultRepo: 'dsh-work-vault', defaultParent: '' });
      const [settingsTab, setSettingsTab] = useState('account');
      const [deviceAuth, setDeviceAuth] = useState(null);
      const devicePollRef = useRef(null);
      const [notesList, setNotesList] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_work_notes_v1') : null;
          if (raw) return JSON.parse(raw);
        } catch (_) {}
        return [
          {
            id: 'note-welcome',
            title: 'Personal Scratchpad',
            updatedAt: Date.now(),
            messages: [
              { id: 'm-welcome', sender: 'You', senderName: 'You', content: '# Personal Scratchpad\nBrainstorm architecture, capture thoughts, or store code snippets here. Attach files or export to markdown at any time.', created_at: Date.now(), files: [] },
            ],
          },
        ];
      });
      const saveChannels = next => {
        setChannels(next);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ channels: next });
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_channels_v1', JSON.stringify(next)); } catch (_) {}
      };
      const saveNotes = updated => {
        setNotesList(updated);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ notesList: updated });
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_notes_v1', JSON.stringify(updated));
        } catch (_) {}
      };
      const handleCreateNewNote = () => {
        const id = 'note-' + Date.now();
        const title = 'Note #' + (notesList.length + 1);
        const newNote = { id, title, docText: `# ${title}\n- `, updatedAt: Date.now(), messages: [] };
        saveNotes([newNote, ...notesList]);
        selectConversation({ peerToken: id, alias: title, isNote: true, status: 'online' });
      };
      const handleExportActiveNote = note => {
        if (!note) return;
        const body = note.docText || (note.messages || []).map(m => `### ${m.senderName || 'Note'} (${new Date(m.created_at || Date.now()).toLocaleString()})\n\n${m.content || ''}\n`).join('\n---\n\n');
        const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${note.title.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.md`;
        a.click();
        URL.revokeObjectURL(url);
        notify('Note exported to markdown', 'success');
      };
      const handleSaveIntelToNote = item => {
        if (!item) return;
        const noteTitle = item.title ? item.title.slice(0, 50) : `Intel Note (${item.platform || 'web'})`;
        const noteBody = `### [Intel: ${item.platform ? item.platform.toUpperCase() : 'WEB'}] ${item.title || ''}\nSource: ${item.url || 'N/A'}\nAuthor: ${item.author || 'Anonymous'} | ${new Date(item.created_at || Date.now()).toLocaleString()}\n\n${item.text || ''}`;
        const newMsg = { id: 'msg-' + Date.now(), sender: 'Intel Engine', senderName: item.platform || 'Intel', content: noteBody, created_at: Date.now(), files: [] };
        const now = Date.now();
        const targetNote = notesList[0];
        if (targetNote) {
          const baseDoc = targetNote.docText ?? (targetNote.messages || []).map(m => m.content).join('\n\n');
          const nextDoc = [baseDoc, noteBody].filter(Boolean).join('\n\n---\n\n');
          saveNotes(notesList.map((n, idx) => idx === 0 ? { ...n, updatedAt: now, externalAppendAt: now, docText: nextDoc, messages: [...(n.messages || []), newMsg] } : n));
          notify(`Saved "${noteTitle}" to Notes`, 'success');
        } else {
          saveNotes([{ id: 'note-' + now, title: 'Intel Scratchpad', docText: noteBody, updatedAt: now, externalAppendAt: now, messages: [newMsg] }]);
          notify(`Saved "${noteTitle}" to new Note`, 'success');
        }
      };

      const setWorkTab = tab => {
        setWorkTabState(tab);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) {
          workSurface.activeTab = tab;
          workSurface.updateState({ workTab: tab });
        }
      };
      const setActivePeer = peer => {
        setActivePeerState(peer);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ activePeer: peer });
      };
      const setConversationFilter = filter => {
        setConversationFilterState(filter);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ conversationFilter: filter });
      };

      useEffect(() => {
        const unsubState = (typeof workSurface !== 'undefined' && workSurface.subscribeState)
          ? workSurface.subscribeState(shared => {
              if (shared.workTab) setWorkTabState(shared.workTab);
              if (typeof shared.managementOpen === 'boolean') setManagementOpenState(shared.managementOpen);
              if (shared.activePeer) setActivePeerState(shared.activePeer);
              if (typeof shared.showConversation === 'boolean') setShowConversationState(shared.showConversation);
              if (shared.conversationFilter) setConversationFilterState(shared.conversationFilter);
              if (typeof shared.workspaceDir === 'string') setWorkspaceDirState(shared.workspaceDir);
              if (typeof shared.audioPopoverOpen === 'boolean') setAudioPopoverOpenState(shared.audioPopoverOpen);
              if (Array.isArray(shared.channels)) setChannels(shared.channels);
              if (Array.isArray(shared.notesList)) setNotesList(shared.notesList);
              if (typeof shared.showBubble === 'boolean') setShowBubble(shared.showBubble);
            })
          : () => {};
        const unsubBubble = (typeof workSurface !== 'undefined' && workSurface.subscribeBubble)
          ? workSurface.subscribeBubble(val => setShowBubble(Boolean(val)))
          : () => {};
        return () => { unsubState(); unsubBubble(); };
      }, []);

      useEffect(() => {
        const syncTab = tab => {
          if (!tab) return;
          if (tab === 'settings') {
            setManagementOpenState(true);
            setShowConversationState(true);
            return;
          }
          setWorkTabState(tab);
          setManagementOpenState(false);
          if (tab === 'mesh' || tab === 'intel' || tab === 'music') setShowConversationState(true);
          if (tab === 'music') setAudioPopoverOpenState(true);
          if (tab === 'messages') setShowConversationState(false);
        };
        if (requestedTab) syncTab(requestedTab);
        else if (typeof workSurface !== 'undefined' && workSurface.activeTab) syncTab(workSurface.activeTab);
        if (typeof workSurface !== 'undefined' && workSurface.tabListeners) {
          workSurface.tabListeners.add(syncTab);
          return () => workSurface.tabListeners.delete(syncTab);
        }
      }, [requestedTab]);

      const [attachedFiles, setAttachedFiles] = useState([]);
      const [managementDrawerOpen, setManagementDrawerOpen] = useState(false);
      const [replyTo, setReplyTo] = useState(null);
      const [pendingDeletes, setPendingDeletes] = useState([]);
      const pendingDeletesRef = useRef([]);
      pendingDeletesRef.current = pendingDeletes;
      const [pendingJumpMessageId, setPendingJumpMessageId] = useState(null);
      const [chatSearchMessages, setChatSearchMessages] = useState([]);
      const [chatUserResults, setChatUserResults] = useState([]);
      const [searchingUsers, setSearchingUsers] = useState(false);
      const [peerContextMenu, setPeerContextMenu] = useState(null);
      const [pinnedPeers, setPinnedPeers] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_work_pinned_peers_v1') : null;
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      });
      const [unlinkedPeers, setUnlinkedPeers] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_work_unlinked_peers_v1') : null;
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      });
      const unlinkedPeersRef = useRef(unlinkedPeers);
      unlinkedPeersRef.current = unlinkedPeers;
      const peerListRef = useRef(peerList);
      peerListRef.current = peerList;
      const [recordingVoice, setRecordingVoice] = useState(false);
      const [recordingSeconds, setRecordingSeconds] = useState(0);
      const mediaRecorderRef = useRef(null);
      const voiceSessionRef = useRef(null);
      const composerRef = useRef(null);
      const managementToggleRef = useRef(null);
      const [peerSuggestions, setPeerSuggestions] = useState([]);
      const [searchingPeers, setSearchingPeers] = useState(false);
      const peerSearchTimer = useRef(null);
      const handlePeerSearchChange = val => {
        setPeerSearchInput(val);
        const query = val.trim().replace(/^@/, '');
        if (!query) { setPeerSuggestions([]); return; }
        if (peerSearchTimer.current) clearTimeout(peerSearchTimer.current);
        peerSearchTimer.current = setTimeout(async () => {
          setSearchingPeers(true);
          try {
            const res = await callWorkRpc(connection, 'searchGithubUsers', { query });
            if (res?.ok && Array.isArray(res.value)) setPeerSuggestions(res.value);
          } finally { setSearchingPeers(false); }
        }, 220);
      };
      const fileInputRef = useRef(null);
      const handleAttachFiles = e => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        if (files.some(f => f.size > 16 * 1024 * 1024)) { notify('Each attachment must be 16 MiB or smaller.', 'error'); e.target.value = ''; return; }
        setAttachedFiles(prev => [...prev, ...files]);
        e.target.value = '';
      };
      const handleRemoveAttachedFile = idx => setAttachedFiles(prev => prev.filter((_, i) => i !== idx));
      const [managementOpen, setManagementOpenState] = useState(() => Boolean(initialShared.managementOpen));
      const [showConversation, setShowConversationState] = useState(() => Boolean(initialShared.showConversation));
      const setManagementOpen = val => {
        const next = Boolean(val);
        setManagementOpenState(next);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ managementOpen: next });
      };
      const setShowConversation = val => {
        const next = Boolean(val);
        setShowConversationState(next);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ showConversation: next });
      };
      const selectConversation = peer => { setCommandResult(null); setActivePeer(peer); setShowConversation(true); };
      const [workspaceDir, setWorkspaceDirState] = useState(() => initialShared.workspaceDir || '');
      const setWorkspaceDir = dir => {
        setWorkspaceDirState(dir);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ workspaceDir: dir });
      };
      const [recentWorkspaces, setRecentWorkspaces] = useState(() => {
        try {
          const raw = typeof localStorage !== 'undefined' ? (localStorage.getItem('dsh_work_recent_repos') || localStorage.getItem('dsh_recent_workspaces')) : null;
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string' && p.length < 4096).slice(0, 10) : [];
        } catch { return []; }
      });
      const [customCommitMessage, setCustomCommitMessage] = useState('');
      const [repoStatus, setRepoStatus] = useState(null);
      const [repoDiff, setRepoDiff] = useState(null);
      const [recentStatuses, setRecentStatuses] = useState({});
      useEffect(() => {
        let cancelled = false;
        if (workTab === 'mesh') Promise.all(recentWorkspaces.map(async repoPath => {
          const res = await callWorkRpc(connection, 'getGitStatus', { repoPath });
          return [repoPath, res?.ok ? res.value : null];
        })).then(entries => { if (!cancelled) setRecentStatuses(Object.fromEntries(entries)); });
        return () => { cancelled = true; };
      }, [connection, recentWorkspaces, workTab]);
      const [messages, setMessages] = useState([]);
      const [messageInput, setMessageInput] = useState('');
      const [commandResult, setCommandResult] = useState(null);
      const [timelineFilter, setTimelineFilter] = useState('all');
      const [peerSearchInput, setPeerSearchInput] = useState('');
      const [updateInfo, setUpdateInfo] = useState({ status: 'idle', currentVersion: null, latestVersion: null, assetId: null });
      const [selectedShareRecipients, setSelectedShareRecipients] = useState([]);
      const toggleShareRecipient = useCallback((username) => {
        setSelectedShareRecipients(prev => prev.includes(username) ? prev.filter(u => u !== username) : [...prev, username]);
      }, []);
      const [publishingUpdate, setPublishingUpdate] = useState(false);
      const [restartingUpdate, setRestartingUpdate] = useState(false);
      const [patInput, setPatInput] = useState('');
      const [patBusy, setPatBusy] = useState(false);
      const [drawerOpen, setDrawerOpen] = useState(false);
      const [drawerDiff, setDrawerDiff] = useState(null);
      const [conflicts, setConflicts] = useState([]);
      const [dropActive, setDropActive] = useState(false);
      const [repoError, setRepoError] = useState('');
      const [busy, setBusy] = useState(false);
      const [toast, setToast] = useState(null);
      const [audioPopoverOpen, setAudioPopoverOpenState] = useState(() => Boolean(initialShared.audioPopoverOpen));
      const setAudioPopoverOpen = val => {
        const next = Boolean(val);
        setAudioPopoverOpenState(next);
        if (typeof workSurface !== 'undefined' && workSurface.updateState) workSurface.updateState({ audioPopoverOpen: next });
      };
      const streamRef = useRef(null);
      const wasNearBottomRef = useRef(true);
      const forceScrollBottomRef = useRef(true);
      const activeRoomRef = useRef(null);
      const repoSelectSeqRef = useRef(0);
      const [drawerLoading, setDrawerLoading] = useState(false);

      const notify = useCallback((text, tone = 'info') => {
        setToast({ text, tone });
        setTimeout(() => setToast((cur) => (cur?.text === text ? null : cur)), 4000);
      }, []);

      const myGithubLogin = auth?.user?.login || auth?.username || profile?.githubUsername || '';
      const activeRoomId = useMemo(
        () => (activePeer ? buildRoomId(profile?.machineToken, activePeer, myGithubLogin) : null),
        [auth, profile, activePeer, myGithubLogin]
      );
      activeRoomRef.current = activeRoomId;

      const formatPeerDisplayName = useCallback((peer) => {
        if (!peer) return 'Messages';
        if (peer.isChannel) return String(peer.alias || peer.peerToken || 'general').replace(/^#+/, '');
        if (peer.isNote) return peer.alias || 'Note';
        const cleanCustom = String(peer.customAlias || '').trim();
        if (cleanCustom) return cleanCustom;
        const cleanUser = String(peer.username || '').replace(/^@+/, '').trim();
        const cleanAlias = String(peer.alias || '').trim();
        if (cleanAlias && cleanUser && cleanAlias.replace(/^@+/, '').toLowerCase() !== cleanUser.toLowerCase()) {
          return cleanAlias;
        }
        if (cleanUser) return `@${cleanUser}`;
        return cleanAlias || peer.peerToken || 'Collaborator';
      }, []);

      const normalizePeers = useCallback((list = []) => {
        const byKey = new Map();
        const blocked = new Set((unlinkedPeersRef.current || []).map(x => String(x).toLowerCase()));
        for (const p of list) {
          if (!p) continue;
          const cleanUser = p.username ? String(p.username).replace(/^@+/, '').trim() : '';
          const key = (cleanUser || p.peerToken || '').trim().toLowerCase();
          if (!key || blocked.has(key) || (p.peerToken && blocked.has(String(p.peerToken).toLowerCase()))) continue;
          const prev = byKey.get(key);
          const customAlias = p.customAlias !== undefined
            ? (String(p.customAlias || '').trim() || null)
            : (prev?.customAlias || null);
          const nextAlias = (p.alias || '').trim();
          const prevAlias = (prev?.alias || '').trim();
          const chosenAlias = customAlias
            || ((nextAlias && (!cleanUser || nextAlias.replace(/^@+/, '').toLowerCase() !== cleanUser.toLowerCase())) ? nextAlias : null)
            || prevAlias
            || (cleanUser ? `@${cleanUser}` : p.peerToken);
          byKey.set(key, {
            ...(prev || {}),
            ...p,
            username: cleanUser || prev?.username || null,
            peerToken: cleanUser || prev?.username || p.peerToken,
            linkToken: p.linkToken || prev?.linkToken || null,
            isRegistry: Boolean(p.isRegistry || prev?.isRegistry),
            avatarUrl: p.avatarUrl || p.avatar || prev?.avatarUrl || null,
            customAlias,
            alias: chosenAlias,
            status: (p.status === 'online' || prev?.status === 'online') ? 'online' : 'offline',
          });
        }
        return Array.from(byKey.values());
      }, []);

      useEffect(() => {
        callWorkRpc(connection, 'getMachineProfile').then((res) => { if (res?.ok && res.value) setProfile(res.value); });
        callWorkRpc(connection, 'getGithubAuth').then((res) => {
          if (res?.ok && res.value?.connected) {
            setAuth(res.value);
            callWorkRpc(connection, 'checkPendingVaultInvitations').then(inv => {
              if (inv?.ok && Array.isArray(inv.value)) setPendingInvites(inv.value);
            });
          }
        });
        callWorkRpc(connection, 'getConfig').then((res) => {
          if (res?.ok && res.value) {
            const loaded = { machineName: res.value.machineName || 'Workstation', vaultRepo: res.value.vaultRepo || 'dsh-work-vault', defaultParent: res.value.defaultParent || '' };
            setWorkConfig(loaded);
            setSavedWorkConfig(loaded);
            if (typeof res.value.showBubble === 'boolean') {
              setShowBubble(res.value.showBubble);
              if (typeof workSurface !== 'undefined' && workSurface.setBubbleEnabled) workSurface.setBubbleEnabled(res.value.showBubble, true);
            }
          }
        });
        callWorkRpc(connection, 'getPeerLinks').then((res) => {
          if (res?.ok && Array.isArray(res.value)) setPeerList(prev => normalizePeers([...prev, ...res.value.map(p => ({ ...p, linkToken: p.peerToken }))]));
        });
        callWorkRpc(connection, 'getRealtimeStatus').then((res) => { if (res?.ok && res.value) setRealtimeStatus(res.value); });
      }, [connection, normalizePeers]);

      useEffect(() => {
        if (typeof workSurface !== 'undefined') {
          workSurface.setUpdate(updateInfo.status === 'available' ? updateInfo : null);
          workSurface.onTriggerUpdate = handleRestartToUpdate;
        }
      }, [updateInfo]);

      useEffect(() => {
        const fetchPeers = () => {
          callWorkRpc(connection, 'getRealtimeStatus').then((res) => {
            if (res?.ok && res.value) setRealtimeStatus(res.value);
          });
          if (auth?.connected) {
            callWorkRpc(connection, 'getOnlineRegistryPeers').then((res) => {
              if (res?.ok && Array.isArray(res.value)) {
                setPeerList((prev) => normalizePeers([...prev, ...res.value.map(p => ({ ...p, isRegistry: true }))]));
              }
            });
          }
        };
        fetchPeers();
        const interval = setInterval(fetchPeers, 8000);
        return () => clearInterval(interval);
      }, [connection, normalizePeers, auth?.connected]);

      useEffect(() => {
        if (!activeRoomId) { setMessages([]); return; }
        let cancelled = false;
        let inFlight = false;
        forceScrollBottomRef.current = true;
        wasNearBottomRef.current = true;
        setMessages([]);
        const pollRoom = async () => {
          if (inFlight || cancelled) return;
          inFlight = true;
          try {
            const res = await callWorkRpc(connection, 'getChatMessages', { roomId: activeRoomId });
            if (!cancelled && activeRoomRef.current === activeRoomId && res?.ok && Array.isArray(res.value)) {
              setMessages(res.value);
            }
          } finally { inFlight = false; }
        };
        pollRoom();
        const pollIntervalMs = (typeof document !== 'undefined' && document.hidden)
          ? 4000
          : (workTab === 'messages' || workTab === 'mesh') ? 1200 : 4000;
        const interval = setInterval(pollRoom, pollIntervalMs);
        return () => { cancelled = true; clearInterval(interval); };
      }, [connection, activeRoomId, workTab]);

      useEffect(() => {
        const el = streamRef.current;
        if (!el) return;
        if (forceScrollBottomRef.current || wasNearBottomRef.current) {
          el.scrollTop = el.scrollHeight;
          forceScrollBottomRef.current = false;
        }
      }, [messages.length, activeRoomId]);

      const refreshGitStatus = useCallback(async (dir, expectedSeq = null) => {
        const target = dir || workspaceDir;
        if (!target) return null;
        const st = await callWorkRpc(connection, 'getGitStatus', { repoPath: target });
        if (expectedSeq !== null && expectedSeq !== repoSelectSeqRef.current) return null;
        if (st?.ok) {
          setRepoStatus(st.value);
          setRecentStatuses(prev => ({ ...prev, [target]: st.value }));
          const diff = st.value?.isGit ? await callWorkRpc(connection, 'getGitDiff', { repoPath: target }) : null;
          if (expectedSeq !== null && expectedSeq !== repoSelectSeqRef.current) return null;
          setRepoDiff(diff?.ok ? diff.value : null);
          if (st.value?.isGit) {
            callWorkRpc(connection, 'getRepoOverview', { repoPath: target }).then(ov => { if (ov?.ok) setRepoOverview(ov.value); });
            callWorkRpc(connection, 'getRepoDeployments', { repoPath: target }).then(dep => { if (dep?.ok && Array.isArray(dep.value)) setDeployments(dep.value); });
          } else {
            setRepoOverview(null);
            setDeployments([]);
          }
          return st.value;
        }
        return null;
      }, [connection, workspaceDir]);

      useEffect(() => {
        if (workTab === 'mesh' && !workspaceDir && recentWorkspaces.length > 0) {
          selectRepository(recentWorkspaces[0]);
        } else if (workTab === 'mesh' && workspaceDir && repoStatus?.path !== workspaceDir) {
          refreshGitStatus(workspaceDir);
        }
      }, [workTab, workspaceDir, recentWorkspaces.length]);

      const handleToggleBubble = async (next) => {
        const enabled = Boolean(next);
        setShowBubble(enabled);
        if (typeof workSurface !== 'undefined' && workSurface.setBubbleEnabled) workSurface.setBubbleEnabled(enabled, true);
        await callWorkRpc(connection, 'setConfig', { showBubble: enabled });
      };

      useEffect(() => {
        const refresh = () => { if (workspaceDir) refreshGitStatus(workspaceDir); };
        window.addEventListener?.('focus', refresh);
        return () => window.removeEventListener?.('focus', refresh);
      }, [workspaceDir, refreshGitStatus]);

      const handleRemoveRepository = useCallback((repoPath) => {
        setRecentWorkspaces(prev => {
          const next = prev.filter(p => p !== repoPath);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_recent_repos', JSON.stringify(next)); } catch {}
          return next;
        });
        if (workspaceDir === repoPath) {
          setWorkspaceDir('');
          setRepoStatus(null);
          setRepoDiff(null);
          setSelectedDiffFile('');
        }
      }, [workspaceDir]);

      const findLocalRepoForCard = useCallback((meta) => {
        const targetId = meta?.repoId;
        if (!targetId) return workspaceDir || null;
        if (workspaceDir && repoStatus?.repoId === targetId) return workspaceDir;
        for (const p of recentWorkspaces) {
          if (recentStatuses[p]?.repoId === targetId) return p;
        }
        return null;
      }, [workspaceDir, repoStatus?.repoId, recentWorkspaces, recentStatuses]);

      const addRecentWorkspace = useCallback((newPath) => {
        if (!newPath) return;
        setRecentWorkspaces((prev) => {
          const next = [newPath, ...prev.filter((p) => p !== newPath)].slice(0, 10);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_recent_repos', JSON.stringify(next)); } catch {}
          return next;
        });
      }, []);

      const handlePickFolder = async () => {
        const res = await callWorkRpc(connection, 'pickDirectory', { title: 'Select Local Git Repository' });
        if (res?.ok && res.value) await selectRepository(res.value);
      };

      const selectRepository = async repoPath => {
        const seq = ++repoSelectSeqRef.current;
        setRepoError('');
        const status = await refreshGitStatus(repoPath, seq);
        if (seq !== repoSelectSeqRef.current) return false;
        if (!status?.isGit) {
          setRepoError('This path is not an accessible Git repository. Choose a local repository folder.');
          if (workspaceDir) await refreshGitStatus(workspaceDir); else setRepoStatus(null);
          return false;
        }
        setWorkspaceDir(repoPath);
        addRecentWorkspace(repoPath);
        return true;
      };

      const handleLinkPeer = async (customUsername) => {
        const username = (typeof customUsername === 'string' ? customUsername : peerSearchInput).trim().replace(/^@+/, '');
        if (!username) return;
        const verified = await callWorkRpc(connection, 'verifyPeerUser', { username });
        if (!verified?.ok || !verified.value?.exists || !verified.value.profile?.username) {
          notify(verified?.error?.message || 'GitHub user not found. Check the username and retry.', 'error');
          return;
        }
        const user = verified.value.profile;
        const cleanLower = user.username.toLowerCase();
        const nextUnlinked = unlinkedPeersRef.current.filter(x => x !== cleanLower && x !== String(user.machineToken || '').toLowerCase());
        unlinkedPeersRef.current = nextUnlinked;
        setUnlinkedPeers(nextUnlinked);
        try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_unlinked_peers_v1', JSON.stringify(nextUnlinked)); } catch {}
        const res = await callWorkRpc(connection, 'savePeerLink', {
          peerToken: user.machineToken || user.username,
          alias: `@${user.username}`,
          username: user.username,
          avatarUrl: user.avatarUrl || null,
          status: user.status || 'offline',
        });
        if (res?.ok && Array.isArray(res.value)) {
          const normalized = normalizePeers([...peerListRef.current.filter(p => p.isRegistry), ...res.value.map(p => ({ ...p, linkToken: p.peerToken }))]);
          setPeerList(normalized);
          const created = normalized.find(p => (p.username || '').toLowerCase() === cleanLower) || { peerToken: user.username, alias: `@${user.username}`, username: user.username, avatarUrl: user.avatarUrl || null, status: user.status || 'offline' };
          setActivePeer(created);
          setConversationFilter('chats');
          setPeerSearchInput('');
          setConversationSearch('');
          setChatUserResults([]);
          setShowConversation(true);
          notify(`Linked @${user.username}`, 'success');
        } else {
          notify(res?.error?.message || 'Peer link failed', 'error');
        }
      };

      const handleSavePeerNickname = async (peer, nextNickname) => {
        if (!peer || peer.isChannel || peer.isNote) return;
        const cleanUser = String(peer.username || peer.peerToken || '').replace(/^@+/, '').trim();
        const cleanCustom = String(nextNickname || '').trim();
        const res = await callWorkRpc(connection, 'savePeerLink', {
          peerToken: peer.linkToken || peer.peerToken,
          username: cleanUser || null,
          customAlias: cleanCustom,
          avatarUrl: peer.avatarUrl || null,
          status: peer.status || 'offline',
        });
        if (res?.ok && Array.isArray(res.value)) {
          const updatedLinks = res.value.map(p => ({ ...p, linkToken: p.peerToken }));
          setPeerList(prev => normalizePeers([...prev.filter(p => p.isRegistry), ...updatedLinks]));
          setActivePeer({
            ...peer,
            customAlias: cleanCustom || null,
            alias: cleanCustom || (cleanUser ? `@${cleanUser}` : peer.peerToken),
          });
          notify(cleanCustom ? `Saved nickname "${cleanCustom}"` : 'Nickname reset to GitHub username', 'success');
        } else {
          notify(res?.error?.message || 'Could not save nickname', 'error');
        }
      };

      const checkUpdatesSilent = useCallback(async (silent = true) => {
        if (!silent) setUpdateInfo(prev => ({ ...prev, status: 'checking' }));
        const res = await callWorkRpc(connection, 'checkForWorkUpdates');
        if (res?.ok && res.value?.hasUpdate && res.value?.latestVersion) {
          setUpdateInfo(prev => prev.status === 'installed'
            ? prev
            : { status: 'available', currentVersion: res.value.currentVersion || prev.currentVersion, latestVersion: res.value.latestVersion, assetId: res.value.assetId || null });
          if (!silent) notify(`Update v${res.value.latestVersion} available`, 'success');
        } else if (res?.ok && !res.value?.hasUpdate) {
          setUpdateInfo(prev => prev.status === 'installed'
            ? prev
            : { status: 'idle', currentVersion: res.value?.currentVersion || prev.currentVersion, latestVersion: null, assetId: null });
          if (!silent) notify(`Up to date (Work v${res.value?.currentVersion || '2.0.1'})`, 'info');
        } else if (!silent) {
          setUpdateInfo(prev => ({ ...prev, status: 'idle' }));
          notify(res?.error?.message || 'Update check failed', 'error');
        }
        return res;
      }, [connection, notify]);

      const handleRestartToUpdate = async () => {
        if (updateInfo?.status === 'installed' && updateInfo?.manualRestartRequired) return;
        setRestartingUpdate(true);
        try {
          let installedVersion = updateInfo?.latestVersion || null;
          if (updateInfo.status === 'available' && updateInfo.assetId) {
            const res = await callWorkRpc(connection, 'applyWorkUpdate', { version: updateInfo.latestVersion, assetId: updateInfo.assetId });
            if (!res?.ok) {
              notify(res?.error?.message || 'Update install failed', 'error');
              return;
            }
            installedVersion = res.value?.version || installedVersion;
            setUpdateInfo({ status: 'installed', currentVersion: installedVersion, latestVersion: installedVersion, assetId: null, manualRestartRequired: false });
          }
          const restartRes = await callWorkRpc(connection, 'restartDshDesktop');
          if (restartRes?.ok && restartRes.value?.restarting) {
            notify('Restarting DSH Desktop to apply update...', 'success');
          } else {
            setUpdateInfo(prev => ({ ...prev, status: 'installed', currentVersion: installedVersion || prev.currentVersion, latestVersion: installedVersion || prev.latestVersion, assetId: null, manualRestartRequired: true }));
            notify(`Updated${installedVersion ? ` to v${installedVersion}` : ''} — Restart DSH manually.`, 'success');
          }
        } finally {
          setRestartingUpdate(false);
        }
      };

      const handlePublishUpdate = async () => {
        setPublishingUpdate(true);
        try {
          const res = await callWorkRpc(connection, 'publishWorkUpdate', {});
          if (res?.ok) {
            setUpdateInfo({ status: 'idle', latestVersion: null, assetId: null });
            notify(`Released v${res.value.version}`, 'success');
          } else {
            notify(res?.error?.message || 'Release failed', 'error');
          }
        } finally { setPublishingUpdate(false); }
      };

      const isHost = useMemo(() => {
        const login = (auth?.user?.login || auth?.username || profile?.githubUsername || '').toLowerCase();
        return login === 'aoiuyy';
      }, [auth, profile]);

      useEffect(() => {
        if (!auth?.connected) return;
        checkUpdatesSilent();
        const interval = setInterval(checkUpdatesSilent, 90000);
        return () => clearInterval(interval);
      }, [auth?.connected, checkUpdatesSilent]);

      useEffect(() => {
        if (managementOpen && auth?.connected) checkUpdatesSilent();
      }, [managementOpen, auth?.connected, checkUpdatesSilent]);

      useEffect(() => {
        if (typeof workSurface !== 'undefined' && workSurface.updateState) {
          workSurface.updateState({ isHost, publishingUpdate, onPublishUpdate: handlePublishUpdate });
        }
      }, [isHost, publishingUpdate]);

      const handleAcceptInvite = async (inv) => {
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'acceptVaultInvitation', { invitationId: inv.id, vaultRepo: inv.repoFullName });
          if (res?.ok) {
            setPendingInvites(prev => prev.filter(i => i.id !== inv.id));
            const cfgRes = await callWorkRpc(connection, 'getConfig');
            if (cfgRes?.ok && cfgRes.value) {
              const synced = { machineName: cfgRes.value.machineName || 'Workstation', vaultRepo: cfgRes.value.vaultRepo || 'dsh-work-vault', defaultParent: cfgRes.value.defaultParent || '' };
              setWorkConfig(synced);
              setSavedWorkConfig(synced);
            }
            notify(`Accepted Vault invite for ${inv.repoFullName}`, 'success');
          } else notify(res?.error?.message || 'Could not accept invitation', 'error');
        } finally { setBusy(false); }
      };

      const handlePickDefaultParent = async () => {
        const res = await callWorkRpc(connection, 'pickDirectory', { title: 'Select Default Clone Folder' });
        if (res?.ok && res.value) setWorkConfig(prev => ({ ...prev, defaultParent: res.value }));
      };

      const handleSaveConfig = async () => {
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'setConfig', workConfig);
          if (res?.ok && res.value) {
            setWorkConfig(res.value);
            setSavedWorkConfig(res.value);
            setProfile(prev => prev ? { ...prev, machineName: res.value.machineName } : prev);
            notify('Workstation settings saved', 'success');
          } else notify(res?.error?.message || 'Could not save config', 'error');
        } finally { setBusy(false); }
      };

      const togglePinPeer = (peer) => {
        const key = String(peer?.username || peer?.peerToken || '').replace(/^@+/, '').trim().toLowerCase();
        if (!key) return;
        setPinnedPeers(prev => {
          const next = prev.includes(key) ? prev.filter(k => k !== key) : [key, ...prev];
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_pinned_peers_v1', JSON.stringify(next)); } catch {}
          return next;
        });
      };

      const handleUnlinkPeer = async (peer, deleteHistory = false) => {
        if (!peer) return;
        setBusy(true);
        try {
          const key = String(peer.username || peer.peerToken || '').replace(/^@+/, '').trim().toLowerCase();
          const blockKeys = [key, peer.peerToken, peer.linkToken].filter(Boolean).map(x => String(x).toLowerCase());
          const nextUnlinked = [...new Set([...unlinkedPeersRef.current, ...blockKeys])];
          unlinkedPeersRef.current = nextUnlinked;
          setUnlinkedPeers(nextUnlinked);
          try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_unlinked_peers_v1', JSON.stringify(nextUnlinked)); } catch {}
          setPinnedPeers(prev => {
            const next = prev.filter(k => k !== key);
            try { if (typeof localStorage !== 'undefined') localStorage.setItem('dsh_work_pinned_peers_v1', JSON.stringify(next)); } catch {}
            return next;
          });
          await callWorkRpc(connection, 'removePeerLink', {
            peerToken: peer.linkToken || peer.peerToken,
            username: peer.username || null,
          });
          if (deleteHistory) {
            const targetRoomId = buildRoomId(profile?.machineToken, peer, myGithubLogin);
            if (targetRoomId) {
              await callWorkRpc(connection, 'deleteChatRoom', { roomId: targetRoomId });
              if (activeRoomRef.current === targetRoomId) setMessages([]);
            }
          }
          setPeerList(prev => prev.filter(p => {
            const pk = String(p.username || p.peerToken || '').replace(/^@+/, '').trim().toLowerCase();
            return pk !== key && String(p.peerToken || '').toLowerCase() !== String(peer.peerToken || '').toLowerCase();
          }));
          if (activePeer && (String(activePeer.peerToken || '').toLowerCase() === String(peer.peerToken || '').toLowerCase() || (peer.username && String(activePeer.username || '').toLowerCase() === String(peer.username).toLowerCase()))) {
            setActivePeer(channels[0] || channelPeer('general'));
          }
          notify(deleteHistory ? 'Unlinked and deleted chat history' : 'Collaborator unlinked', 'info');
        } finally { setBusy(false); }
      };

      useEffect(() => {
        if (!peerContextMenu || typeof window === 'undefined') return;
        const closeMenu = () => setPeerContextMenu(null);
        const onKey = e => { if (e.key === 'Escape') setPeerContextMenu(null); };
        window.addEventListener('click', closeMenu);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('click', closeMenu);
          window.removeEventListener('keydown', onKey);
        };
      }, [peerContextMenu]);

      const handleCancelDeviceLogin = () => {
        if (devicePollRef.current) { clearTimeout(devicePollRef.current); devicePollRef.current = null; }
        setDeviceAuth(null);
        setPatBusy(false);
      };

      const handleStartDeviceLogin = async () => {
        handleCancelDeviceLogin();
        setPatBusy(true);
        try {
          const res = await callWorkRpc(connection, 'requestDeviceLogin', { repo: workConfig.vaultRepo });
          if (!res?.ok || !res.value?.deviceCode) throw new Error(res?.error?.message || 'Device login unavailable');
          const info = res.value;
          setDeviceAuth(info);
          if (info.userCode && typeof navigator !== 'undefined') {
            navigator.clipboard?.writeText?.(info.userCode).catch(() => {});
          }
          const openUrl = info.verificationUriComplete || info.verificationUri;
          if (openUrl && typeof window !== 'undefined' && typeof window.open === 'function') {
            try { window.open(openUrl, '_blank', 'noopener,noreferrer'); } catch {}
          }
          const intervalMs = Math.max(5000, (Number(info.interval) || 5) * 1000);
          const poll = async () => {
            const pollRes = await callWorkRpc(connection, 'pollDeviceLogin', { deviceCode: info.deviceCode, repo: workConfig.vaultRepo });
            if (pollRes?.ok && pollRes.value?.status === 'success' && pollRes.value?.authenticated) {
              setDeviceAuth(null);
              setPatBusy(false);
              const authRes = await callWorkRpc(connection, 'getGithubAuth');
              if (authRes?.ok && authRes.value?.connected) setAuth(authRes.value);
              notify(`Connected GitHub as @${pollRes.value.user?.login || 'user'}`, 'success');
              return;
            }
            if (!pollRes?.ok || pollRes.value?.status === 'expired' || pollRes.value?.status === 'denied') {
              setDeviceAuth(null);
              setPatBusy(false);
              notify(pollRes?.error?.message || `GitHub device login ${pollRes?.value?.status || 'failed'}`, 'error');
              return;
            }
            devicePollRef.current = setTimeout(poll, intervalMs);
          };
          devicePollRef.current = setTimeout(poll, intervalMs);
        } catch (err) {
          setDeviceAuth(null);
          setPatBusy(false);
          notify(err.message || 'Device login failed', 'error');
        }
      };

      useEffect(() => () => { if (devicePollRef.current) clearTimeout(devicePollRef.current); }, []);

      const handleConnectGithub = async () => {
        const token = patInput.trim();
        if (!token) return;
        setPatBusy(true);
        try {
          const res = await callWorkRpc(connection, 'setGithubAuth', { token });
          if (res?.ok && res.value) {
            setAuth({ connected: true, user: { login: res.value.login }, maskedToken: res.value.maskedToken, isDpapiProtected: res.value.isDpapiProtected });
            setPatInput('');
            notify(`Connected GitHub as @${res.value.login}`, 'success');
          } else {
            notify(res?.error?.message || 'GitHub connection failed', 'error');
          }
        } catch (err) {
          notify(err.message || 'Connection error', 'error');
        } finally { setPatBusy(false); }
      };

      const handleDisconnectGithub = async () => {
        setPatBusy(true);
        try {
          const res = await callWorkRpc(connection, 'disconnectGithub');
          if (res?.ok) { setAuth(null); notify('GitHub disconnected from DPAPI vault', 'info'); }
          else notify(res?.error?.message || 'Disconnect failed', 'error');
        } finally { setPatBusy(false); }
      };

      const readChatFile = file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read attachment.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(file);
      });
      const commitDeleteMessage = useCallback(async (roomId, message) => {
        if (!roomId || !message?.id) return false;
        try {
          const res = await callWorkRpc(connection, 'deleteChatMessage', { roomId, messageId: message.id });
          if (!res?.ok) throw new Error(res?.error?.message || 'Delete failed.');
          const refreshed = await callWorkRpc(connection, 'getChatMessages', { roomId });
          if (refreshed?.ok && activeRoomRef.current === roomId) setMessages(refreshed.value || []);
          return true;
        } catch (err) {
          notify(err.message, 'error');
          return false;
        }
      }, [connection, notify]);

      const requestDeleteMessage = useCallback((message) => {
        const roomId = activeRoomId;
        if (!roomId || !message?.id) return;
        setPendingDeletes(prev => prev.some(d => d.id === message.id) ? prev : [...prev, { id: message.id, roomId, message, remaining: 5 }]);
      }, [activeRoomId]);

      const revertDeleteMessage = useCallback((messageId) => {
        setPendingDeletes(prev => prev.filter(d => d.id !== messageId));
      }, []);

      useEffect(() => {
        if (!pendingDeletes.length) return;
        const timer = setInterval(() => {
          const expired = pendingDeletesRef.current.filter(item => item.remaining <= 1);
          setPendingDeletes(prev => prev.flatMap(item => item.remaining <= 1 ? [] : [{ ...item, remaining: item.remaining - 1 }]));
          for (const item of expired) commitDeleteMessage(item.roomId, item.message);
        }, 1000);
        return () => clearInterval(timer);
      }, [pendingDeletes.length > 0, commitDeleteMessage]);

      useEffect(() => {
        const roomId = activeRoomId;
        return () => {
          const leaving = pendingDeletesRef.current.filter(d => d.roomId === roomId);
          if (leaving.length) {
            setPendingDeletes(prev => prev.filter(d => d.roomId !== roomId));
            for (const item of leaving) commitDeleteMessage(item.roomId, item.message);
          }
        };
      }, [activeRoomId, commitDeleteMessage]);

      useEffect(() => {
        const q = conversationSearch.trim();
        if (!q) {
          setChatSearchMessages([]);
          setChatUserResults([]);
          setSearchingUsers(false);
          return;
        }
        let cancelled = false;
        const msgTimer = setTimeout(async () => {
          const res = await callWorkRpc(connection, 'searchChatMessages', { query: q, limit: 12 });
          if (!cancelled && res?.ok && Array.isArray(res.value)) setChatSearchMessages(res.value);
        }, 150);
        const cleanHandle = q.replace(/^@+/, '');
        const validHandle = /^[a-zA-Z0-9-]{2,39}$/.test(cleanHandle);
        if (!validHandle) {
          setChatUserResults([]);
          setSearchingUsers(false);
        }
        const userTimer = validHandle
          ? setTimeout(async () => {
              setSearchingUsers(true);
              try {
                const res = await callWorkRpc(connection, 'searchGithubUsers', { query: cleanHandle });
                if (!cancelled && res?.ok && Array.isArray(res.value)) {
                  const currentPeers = peerListRef.current || [];
                  setChatUserResults(res.value.filter(u =>
                    u.username.toLowerCase() !== myGithubLogin.toLowerCase()
                    && !currentPeers.some(p => (p.username || '').toLowerCase() === u.username.toLowerCase())
                  ).slice(0, 6));
                }
              } finally {
                if (!cancelled) setSearchingUsers(false);
              }
            }, 300)
          : null;
        return () => {
          cancelled = true;
          clearTimeout(msgTimer);
          if (userTimer) clearTimeout(userTimer);
        };
      }, [conversationSearch, connection, myGithubLogin]);

      useEffect(() => {
        if (!pendingJumpMessageId || !messages.some(m => m.id === pendingJumpMessageId)) return;
        const targetId = pendingJumpMessageId;
        setPendingJumpMessageId(null);
        setTimeout(() => { if (typeof jumpToChatMessage === 'function') jumpToChatMessage(targetId); }, 40);
      }, [messages, pendingJumpMessageId]);

      const openRoomFromSearch = useCallback((match) => {
        const rId = String(match?.roomId || '');
        if (!rId) return;
        if (rId.startsWith('channel:')) {
          const slug = rId.slice('channel:'.length);
          const ch = channels.find(c => c.peerToken === rId) || { peerToken: rId, alias: slug, isChannel: true };
          selectConversation(ch);
        } else if (rId.startsWith('dm-')) {
          const parts = rId.slice(3).split('--');
          const other = parts.find(p => p.toLowerCase() !== myGithubLogin.toLowerCase() && p.toLowerCase() !== (profile?.machineToken || '').toLowerCase()) || parts[0];
          const foundPeer = peerList.find(p => (p.username || '').toLowerCase() === other.toLowerCase() || (p.peerToken || '').toLowerCase() === other.toLowerCase())
            || { peerToken: other, username: other, alias: `@${other}`, status: 'offline' };
          selectConversation(foundPeer);
        }
        setPendingJumpMessageId(match.id);
      }, [channels, peerList, myGithubLogin, profile]);

      const handleChatAction = async (action, message, extra = {}) => {
        if (action === 'deleteChatMessage') {
          requestDeleteMessage(message);
          return true;
        }
        const roomId = activeRoomId;
        const prevMessages = messages;
        const actorToken = myGithubLogin || profile?.machineToken || 'me';
        // Optimistic update for instant UI feedback
        setMessages(list => list.map(m => {
          if (m.id !== message.id) return m;
          if (action === 'pinChatMessage') return { ...m, isPinned: Boolean(extra.isPinned) };
          if (action === 'editChatMessage' && extra.newContent) return { ...m, content: extra.newContent, isEdited: true, editedAt: new Date().toISOString() };
          if (action === 'reactChatMessage' && extra.reaction === 'fire') {
            const cur = Array.isArray(m.reactions?.fire) ? m.reactions.fire : [];
            const myTokens = [myGithubLogin, profile?.machineToken].filter(Boolean).map(t => String(t).toLowerCase());
            const exists = cur.some(t => myTokens.includes(String(t).toLowerCase()));
            const nextFire = exists ? cur.filter(t => !myTokens.includes(String(t).toLowerCase())) : [...cur, actorToken];
            return { ...m, reactions: { ...(m.reactions || {}), fire: nextFire } };
          }
          return m;
        }));
        try {
          const res = await callWorkRpc(connection, action, { roomId, messageId: message.id, ...extra });
          if (!res?.ok) throw new Error(res?.error?.message || 'Message action failed.');
          const refreshed = await callWorkRpc(connection, 'getChatMessages', { roomId });
          if (refreshed?.ok && activeRoomRef.current === roomId) setMessages(refreshed.value || []);
          return true;
        } catch (err) {
          if (activeRoomRef.current === roomId) setMessages(prevMessages);
          notify(err.message, 'error');
          return false;
        }
      };
      const handleDeleteChatFile = async message => {
        const roomId = activeRoomId;
        try {
          const res = await callWorkRpc(connection, 'deleteAttachmentFile', { filePath: message.fileMeta.filePath });
          if (!res?.ok) throw new Error(res?.error?.message || 'Attachment deletion failed.');
          const refreshed = await callWorkRpc(connection, 'getChatMessages', { roomId });
          if (refreshed?.ok && activeRoomRef.current === roomId) setMessages(refreshed.value || []);
        } catch (err) { notify(err.message, 'error'); }
      };
      const stopVoice = send => {
        const session = voiceSessionRef.current;
        if (!session) return;
        session.send = send; clearInterval(session.timer);
        if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
        session.stream?.getTracks().forEach(track => track.stop());
        setRecordingVoice(false);
      };
      const startVoice = async () => {
        if (voiceSessionRef.current || !activeRoomId) return;
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { notify('Voice recording is unavailable. Use a secure browser with microphone access.', 'error'); return; }
        const session = { roomId: activeRoomId, peerToken: activePeer?.isChannel ? undefined : activePeer?.peerToken, replyTo, chunks: [], send: false };
        voiceSessionRef.current = session;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (voiceSessionRef.current !== session) { stream.getTracks().forEach(track => track.stop()); return; }
          session.stream = stream;
          const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
          const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          mediaRecorderRef.current = recorder;
          session.bytes = 0;
          recorder.ondataavailable = e => {
            session.bytes += e.data.size;
            if (session.bytes > 16 * 1024 * 1024) { stopVoice(false); notify('Voice note exceeded 16 MiB and was cancelled.', 'error'); return; }
            if (e.data.size) session.chunks.push(e.data);
          };
          recorder.onerror = () => { session.send = false; stopVoice(false); notify('Microphone recording failed.', 'error'); };
          recorder.onstop = async () => {
            clearInterval(session.timer); stream.getTracks().forEach(track => track.stop());
            if (voiceSessionRef.current === session) { voiceSessionRef.current = null; mediaRecorderRef.current = null; setRecordingVoice(false); }
            if (!session.send) return;
            try {
              const type = recorder.mimeType || mimeType || 'audio/webm';
              const blob = new Blob(session.chunks, { type });
              if (!blob.size || blob.size > 16 * 1024 * 1024) throw new Error('Voice note is empty or exceeds 16 MiB.');
              const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
              const rawBase64 = await readChatFile(blob);
              const res = await callWorkRpc(connection, 'sendChatMessage', { roomId: session.roomId, peerToken: session.peerToken, type: 'voice', content: '', replyTo: session.replyTo, fileMeta: { name: `voice-note.${ext}`, mimeType: type, rawBase64, size: blob.size } });
              if (!res?.ok) throw new Error(res?.error?.message || 'Voice note could not be sent.');
              setReplyTo(null);
            } catch (err) { notify(err.message, 'error'); }
          };
          recorder.start(1000); setRecordingSeconds(0); setRecordingVoice(true);
          session.timer = setInterval(() => setRecordingSeconds(seconds => seconds + 1), 1000);
        } catch (err) { session.stream?.getTracks().forEach(track => track.stop()); voiceSessionRef.current = null; notify(`Microphone: ${err.message}`, 'error'); }
      };
      useEffect(() => {
        setReplyTo(null); setManagementDrawerOpen(false); setRecordingVoice(false);
        return () => {
          const session = voiceSessionRef.current;
          if (session) { session.send = false; clearInterval(session.timer); session.stream?.getTracks().forEach(track => track.stop()); }
          if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop();
          voiceSessionRef.current = null;
        };
      }, [activeRoomId, workTab]);

      const handleSendMessage = async () => {
        if (busy || (!messageInput.trim() && !attachedFiles.length)) return;
        if (activePeer?.isNote) {
          const fileNote = attachedFiles.length ? '\n\n' + attachedFiles.map(f => `[File] [${f.name}] (${(f.size / 1024).toFixed(1)} KB)`).join('\n') : '';
          const newMsg = { id: 'msg-' + Date.now(), sender: 'You', senderName: 'You', content: (messageInput.trim() || 'Attached files') + fileNote, created_at: Date.now(), files: [...attachedFiles] };
          saveNotes(notesList.map(n => n.id === activePeer.peerToken ? { ...n, updatedAt: Date.now(), messages: [...(n.messages || []), newMsg] } : n));
          setMessageInput('');
          setAttachedFiles([]);
          return;
        }
        if (!activeRoomId || busy || recordingVoice) return;
        const text = messageInput.trim();
        if (text.startsWith('/') && !attachedFiles.length) {
          setBusy(true);
          try {
            const result = await callWorkRpc(connection, 'executeChatCommand', { repoDir: workspaceDir, text, peerToken: activePeer.peerToken, roomId: activeRoomId });
            if (!result?.ok) { notify(result?.error?.message || 'Command failed', 'error'); return; }
            setMessageInput('');
            setAttachedFiles([]);
            const value = result.value;
            setCommandResult(value);
            if (value?.kind === 'diff') { setDrawerDiff(value.diff); setDrawerOpen(true); }
            if (value?.kind === 'commit') await refreshGitStatus(workspaceDir);
            const refreshed = await callWorkRpc(connection, 'getChatMessages', { roomId: activeRoomId });
            if (refreshed?.ok && Array.isArray(refreshed.value)) setMessages(refreshed.value);
            notify(value?.message || 'Command completed', 'success');
          } finally { setBusy(false); }
          return;
        }
        const roomId = activeRoomId;
        const files = [...attachedFiles];
        const optimisticId = (!files.length && text) ? `temp-${Date.now()}` : null;
        if (optimisticId) {
          forceScrollBottomRef.current = true;
          const optimisticMsg = {
            id: optimisticId,
            roomId,
            sender: profile?.machineToken || 'me',
            senderGithub: myGithubLogin || undefined,
            senderName: myGithubLogin ? `@${myGithubLogin}` : (profile?.machineName || 'You'),
            content: text,
            type: 'text',
            replyTo: replyTo ? { id: replyTo.id, sender: replyTo.sender, senderName: replyTo.senderName, content: replyTo.content } : undefined,
            created_at: new Date().toISOString(),
          };
          setMessages(prev => [...prev, optimisticMsg]);
          setMessageInput('');
          setReplyTo(null);
        }
        setBusy(true);
        try {
          for (let i = 0; i < Math.max(1, files.length); i++) {
            const file = files[i];
            const fileMeta = file ? { name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream', rawBase64: await readChatFile(file) } : undefined;
            const res = await callWorkRpc(connection, 'sendChatMessage', { roomId, peerToken: activePeer?.isChannel ? undefined : activePeer?.peerToken, content: i === 0 ? text : '', type: file ? 'file' : 'text', fileMeta, replyTo });
            if (!res?.ok) {
              if (optimisticId) {
                setMessages(prev => prev.filter(m => m.id !== optimisticId));
                setMessageInput(text);
              }
              const retained = res?.error?.details?.message;
              if (retained) {
                setMessages(prev => [...prev.filter(m => m.id !== retained.id), retained]);
                if (file) setAttachedFiles(prev => prev.filter(item => item !== file));
                if (i === 0) { setMessageInput(''); setReplyTo(null); }
              }
              throw new Error(res?.error?.message || 'Message failed.');
            }
            if (file) setAttachedFiles(prev => prev.filter(item => item !== file));
            if (i === 0 && !optimisticId) { setMessageInput(''); setReplyTo(null); }
          }
          forceScrollBottomRef.current = true;
          const refreshed = await callWorkRpc(connection, 'getChatMessages', { roomId });
          if (refreshed?.ok && activeRoomRef.current === roomId) setMessages(refreshed.value || []);
        } catch (err) {
          if (optimisticId) setMessages(prev => prev.filter(m => m.id !== optimisticId));
          notify(err.message, 'error');
        }
        finally { setBusy(false); }
      };

      const shareDirectory = async (dirPath, metadata = {}) => {
        if (!activeRoomId || !activePeer || activePeer.isChannel || activePeer.isNote) { notify('Select a collaborator before sharing.', 'error'); return; }
        const target = dirPath || workspaceDir;
        if (!target) { await handlePickFolder(); return; }
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'shareRepository', { ...metadata, repoPath: target, roomId: activeRoomId, peerToken: activePeer.peerToken, recipientUsername: activePeer.username });
          if (!res?.ok) throw new Error(res?.error?.message || 'Vault sharing failed.');
          const room = await callWorkRpc(connection, 'getChatMessages', { roomId: activeRoomId });
          if (room?.ok) setMessages(room.value || []);
          await refreshGitStatus(target);
          notify('Repository shared through Vault Git.', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handleInspectDiff = async (targetRef = 'HEAD') => {
        const peerCard = targetRef && typeof targetRef === 'object';
        const targetRepo = peerCard ? (findLocalRepoForCard(targetRef) || workspaceDir) : workspaceDir;
        if (!targetRepo) { notify('Select or clone the matching repository first', 'error'); return; }
        setDrawerDiff(!peerCard && targetRef === 'HEAD' && repoDiff ? repoDiff : null);
        setDrawerLoading(true);
        setDrawerOpen(true);
        try {
          const res = await callWorkRpc(connection, peerCard ? 'fetchCollabBranch' : 'getGitDiff', peerCard ? { ...targetRef, repoPath: targetRepo } : { repoPath: targetRepo, targetRef });
          if (res?.ok) setDrawerDiff(peerCard ? res.value.diff : res.value);
          else notify(res?.error?.message || 'Diff unavailable', 'error');
        } finally { setDrawerLoading(false); }
      };
      const handleCloneCard = async meta => {
        setBusy(true);
        try {
          let parentDir = workConfig?.defaultParent?.trim();
          if (!parentDir) {
            const picked = await callWorkRpc(connection, 'pickDirectory', { title: 'Select Destination Parent Folder' });
            if (!picked?.ok || !picked.value) return;
            parentDir = picked.value;
          }
          const res = await callWorkRpc(connection, 'cloneSharedRepository', { ...meta, parentDir });
          if (!res?.ok) throw new Error(res?.error?.message || 'Clone failed.');
          const target = res.value.repoPath || res.value.targetDir || res.value.path;
          if (!target) throw new Error('Clone did not return a repository path.');
          await selectRepository(target);
          notify('Repository cloned and opened.', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handlePullAndMerge = async meta => {
        const targetRepo = findLocalRepoForCard(meta) || workspaceDir;
        if (!targetRepo) return;
        setBusy(true);
        try {
          const merged = await callWorkRpc(connection, 'mergeCollabBranch', { ...meta, repoPath: targetRepo });
          if (!merged?.ok) throw new Error(merged?.error?.message || 'Merge failed.');
          if (merged.value?.conflict) {
            if (targetRepo !== workspaceDir) setWorkspaceDir(targetRepo);
            const nextConflicts = await callWorkRpc(connection, 'getMergeConflicts', { repoPath: targetRepo });
            if (nextConflicts?.ok) setConflicts(nextConflicts.value.conflicts || []);
            notify('Resolve the merge conflicts below.', 'error');
          } else notify('Peer changes merged.', 'success');
          await refreshGitStatus(targetRepo);
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handleCommitRepository = async () => {
        if (!workspaceDir || !customCommitMessage.trim()) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'commitRepository', { repoPath: workspaceDir, message: customCommitMessage.trim(), stageAll: false });
          if (!res?.ok) throw new Error(res?.error?.message || 'Commit blocked.');
          setCustomCommitMessage('');
          const nextStatus = await refreshGitStatus(workspaceDir);
          if (!nextStatus?.totalChanges || (selectedDiffFile && ![...(nextStatus.staged || []), ...(nextStatus.modified || []), ...(nextStatus.untracked || [])].includes(selectedDiffFile))) {
            setSelectedDiffFile('');
          }
          notify('Committed on the current branch.', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handleCommitAndPush = async meta => { await shareDirectory(workspaceDir, meta || {}); };
      const handleSyncRepository = async () => {
        if (!workspaceDir || busy) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'syncGitRepository', { repoPath: workspaceDir });
          if (!res?.ok) throw new Error(res?.error?.message || 'Sync failed.');
          await refreshGitStatus(workspaceDir); notify('Fetched Vault branches and pushed HEAD. Uncommitted changes were not sent.', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      useEffect(() => {
        if (!isEmbedded) {
          workSurface.gitState = { branch: repoStatus?.branch, additions: repoDiff?.totalAdditions || 0, deletions: repoDiff?.totalDeletions || 0, busy, available: !!workspaceDir, sync: handleSyncRepository };
          workSurface.gitListeners?.forEach(listener => listener(workSurface.gitState));
        }
      }, [repoStatus, repoDiff, busy, workspaceDir, isEmbedded]);

      const handleResolveConflict = async (filePath, strategy) => {
        const res = await callWorkRpc(connection, 'resolveMergeConflict', { repoPath: workspaceDir, filePath, strategy });
        if (res?.ok) {
          const next = await callWorkRpc(connection, 'getMergeConflicts', { repoPath: workspaceDir });
          setConflicts(next?.ok ? (next.value.conflicts || []) : []);
          notify(`Resolved ${filePath}`, 'success');
        } else {
          notify(res?.error?.message || 'Resolution failed', 'error');
        }
      };
      const handleCompleteMerge = async () => {
        const res = await callWorkRpc(connection, 'completeMerge', { repoPath: workspaceDir });
        if (res?.ok) {
          setConflicts([]);
          await refreshGitStatus(workspaceDir);
          notify(`Merge completed (${res.value.shortHash})`, 'success');
        } else {
          notify(res?.error?.message || 'Complete merge failed', 'error');
        }
      };
      const handleAbortMerge = async () => {
        const res = await callWorkRpc(connection, 'abortMerge', { repoPath: workspaceDir });
        if (res?.ok) {
          setConflicts([]);
          await refreshGitStatus(workspaceDir);
          notify('Merge aborted cleanly', 'info');
        }
      };
      const handleCommitAndShare = async () => {
        if (!workspaceDir) { await handlePickFolder(); return; }
        if (!activeRoomId || !activePeer || activePeer.isNote) {
          notify('Select a collaborator or channel before sharing.', 'error');
          return;
        }
        setBusy(true);
        try {
          if (repoStatus?.totalChanges > 0) {
            const msg = customCommitMessage.trim() || `wip: share ${repoStatus?.branch || 'collab'} (${repoStatus.totalChanges} files)`;
            const committed = await callWorkRpc(connection, 'commitRepository', { repoPath: workspaceDir, message: msg, stageAll: true });
            if (!committed?.ok) throw new Error(committed?.error?.message || 'Commit blocked.');
            setCustomCommitMessage('');
            setSelectedDiffFile('');
          }
          const channelPeers = activePeer.isChannel
            ? peerList.filter(p => !p.isChannel && !p.isNote && p.username).map(p => String(p.username).replace(/^@+/, ''))
            : [];
          const recipientUsernames = [...new Set([...selectedShareRecipients, ...channelPeers])];
          const res = await callWorkRpc(connection, 'shareRepository', {
            repoPath: workspaceDir,
            roomId: activeRoomId,
            peerToken: activePeer.isChannel ? undefined : activePeer.peerToken,
            recipientUsername: activePeer.isChannel ? undefined : activePeer.username,
            recipientUsernames,
          });
          if (!res?.ok) throw new Error(res?.error?.message || 'Vault sharing failed.');
          const room = await callWorkRpc(connection, 'getChatMessages', { roomId: activeRoomId });
          if (room?.ok) setMessages(room.value || []);
          await refreshGitStatus(workspaceDir);
          notify('Committed & shared via E2EE Relay + Vault.', 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handleStageFile = async filePath => {
        if (!workspaceDir) return;
        const res = await callWorkRpc(connection, 'stageGitFiles', { repoPath: workspaceDir, files: [filePath] });
        if (res?.ok) await refreshGitStatus(workspaceDir);
        else notify(res?.error?.message || 'Stage failed', 'error');
      };
      const handleUnstageFile = async filePath => {
        if (!workspaceDir) return;
        const res = await callWorkRpc(connection, 'unstageGitFiles', { repoPath: workspaceDir, files: [filePath] });
        if (res?.ok) await refreshGitStatus(workspaceDir);
        else notify(res?.error?.message || 'Unstage failed', 'error');
      };
      const handleStageAll = async files => {
        if (!workspaceDir || !files?.length) return;
        const res = await callWorkRpc(connection, 'stageGitFiles', { repoPath: workspaceDir, files });
        if (res?.ok) await refreshGitStatus(workspaceDir);
        else notify(res?.error?.message || 'Stage all failed', 'error');
      };
      const handleUnstageAll = async files => {
        if (!workspaceDir || !files?.length) return;
        const res = await callWorkRpc(connection, 'unstageGitFiles', { repoPath: workspaceDir, files });
        if (res?.ok) await refreshGitStatus(workspaceDir);
        else notify(res?.error?.message || 'Unstage all failed', 'error');
      };
      const handleDiscardFile = async filePath => {
        if (!workspaceDir) return;
        const res = await callWorkRpc(connection, 'discardGitFile', { repoPath: workspaceDir, filePath });
        if (res?.ok) {
          if (selectedDiffFile === filePath) setSelectedDiffFile('');
          await refreshGitStatus(workspaceDir);
          notify(`Discarded ${filePath}`, 'info');
        } else notify(res?.error?.message || 'Discard failed', 'error');
      };
      const handleSwitchBranch = async branch => {
        if (!workspaceDir || !branch) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'switchGitBranch', { repoPath: workspaceDir, branch });
          if (res?.ok) { await refreshGitStatus(workspaceDir); notify(`Switched to ${branch}`, 'success'); }
          else notify(res?.error?.message || 'Switch failed', 'error');
        } finally { setBusy(false); }
      };
      const handleCreateBranch = async branch => {
        if (!workspaceDir || !branch) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'switchGitBranch', { repoPath: workspaceDir, branch, create: true });
          if (res?.ok) { await refreshGitStatus(workspaceDir); notify(`Created branch ${branch}`, 'success'); }
          else notify(res?.error?.message || 'Create branch failed', 'error');
        } finally { setBusy(false); }
      };
      const handlePublishGithub = async () => {
        if (!workspaceDir) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'publishToGithub', { repoPath: workspaceDir, commitMessage: customCommitMessage.trim(), isPrivate: true });
          if (!res?.ok) throw new Error(res?.error?.message || 'Publish failed.');
          setCustomCommitMessage('');
          await refreshGitStatus(workspaceDir);
          notify(`Published to GitHub: ${res.value?.htmlUrl || 'origin'}`, 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };
      const handlePushOrigin = async () => {
        if (!workspaceDir) return;
        setBusy(true);
        try {
          const res = await callWorkRpc(connection, 'pushToOrigin', { repoPath: workspaceDir, commitMessage: customCommitMessage.trim() });
          if (!res?.ok) throw new Error(res?.error?.message || 'Push failed.');
          setCustomCommitMessage('');
          await refreshGitStatus(workspaceDir);
          notify(`Pushed ${res.value?.branch || 'HEAD'} to GitHub`, 'success');
        } catch (err) { notify(err.message, 'error'); }
        finally { setBusy(false); }
      };

      const handleDrop = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDropActive(false);
        if (workTab !== 'mesh') return;
        const dropped = droppedRepositoryPath(e.dataTransfer);
        if (!dropped) {
          setRepoError('This browser did not provide a local folder path. Use Choose repository to open the native folder picker.');
          return;
        }
        await selectRepository(dropped);
      };

      const filteredMessages = useMemo(() => {
        if (activePeer?.isNote) {
          const n = notesList.find(item => item.id === activePeer.peerToken);
          return n?.messages || [];
        }
        const pendingIds = new Set(pendingDeletes.map(d => d.id));
        const visible = pendingIds.size ? messages.filter(m => !pendingIds.has(m.id)) : messages;
        if (workTab === 'mesh') return visible.filter((m) => m.type === 'repo-card');
        if (timelineFilter === 'messages') return visible.filter((m) => m.type !== 'repo-card');
        if (timelineFilter === 'repos') return visible.filter((m) => m.type === 'repo-card');
        return visible;
      }, [messages, pendingDeletes, timelineFilter, workTab, activePeer, notesList]);

      const repoFolderBasename = workspaceDir ? workspaceDir.split(/[\\/]/).pop() : null;
      const pinnedSet = new Set(pinnedPeers.map(x => String(x).toLowerCase()));
      const peerKeyOf = (p) => String(p?.username || p?.peerToken || '').replace(/^@+/, '').trim().toLowerCase();
      const visiblePeers = peerList
        .filter(peer => `${formatPeerDisplayName(peer)} ${peer.alias || ''} ${peer.username || ''} ${peer.peerToken}`.toLowerCase().includes(conversationSearch.toLowerCase().trim()) && (conversationFilter !== 'online' || peer.status === 'online'))
        .sort((a, b) => {
          const ap = pinnedSet.has(peerKeyOf(a)) ? 0 : 1;
          const bp = pinnedSet.has(peerKeyOf(b)) ? 0 : 1;
          return ap - bp;
        });
      const onlinePeerCount = peerList.filter(peer => peer.status === 'online').length;
      const activePeerDisplay = formatPeerDisplayName(activePeer);
      const conversationLabel = activePeer ? (activePeer.isChannel ? `#${activePeerDisplay}` : activePeerDisplay) : 'Messages';
      const showContextualRail = (workTab === 'messages' || workTab === 'mesh') && !managementOpen;

      return h('div', { className: `wk-app ${isEmbedded ? 'wk-embedded' : ''} ${showConversation ? 'wk-conversation-open' : ''}` }, [
        toast && h('div', { className: `wk-toast ${toast.tone}`, role: 'status' }, toast.text),
        h('div', { className: `wk-body ${showContextualRail ? 'with-rail' : 'no-rail'}` }, [
          h('nav', { className: 'wk-nav-dock', 'aria-label': 'Work sections' }, [
            h('button', {
              key: 'messages',
              className: `wk-dock-item ${workTab === 'messages' && !managementOpen ? 'active' : ''}`,
              'aria-pressed': workTab === 'messages' && !managementOpen,
              'aria-label': 'Messages',
              onClick: () => { setWorkTab('messages'); setManagementOpen(false); setAudioPopoverOpen(false); },
            }, [h(SvgIcon, { path: Icons.Chat, size: 20 }), h('span', { className: 'wk-dock-label' }, 'Chats'), onlinePeerCount > 0 && h('span', { className: 'wk-dock-badge', title: `${onlinePeerCount} online` })]),
            h('button', {
              key: 'mesh',
              className: `wk-dock-item ${workTab === 'mesh' && !managementOpen ? 'active' : ''}`,
              'aria-pressed': workTab === 'mesh' && !managementOpen,
              'aria-label': 'Git Mesh',
              onClick: () => { setWorkTab('mesh'); setManagementOpen(false); setAudioPopoverOpen(false); setShowConversation(true); },
            }, [h(SvgIcon, { path: Icons.Github, size: 20 }), h('span', { className: 'wk-dock-label' }, 'Repo')]),
            h('button', {
              key: 'music',
              className: `wk-dock-item ${workTab === 'music' && !managementOpen ? 'active' : ''}`,
              'aria-pressed': workTab === 'music' && !managementOpen,
              'aria-label': 'Music',
              onClick: () => { setWorkTab('music'); setManagementOpen(false); setAudioPopoverOpen(true); setShowConversation(true); },
            }, [h(SvgIcon, { path: Icons.AppleMusic, size: 20 }), h('span', { className: 'wk-dock-label' }, 'Music')]),
            h('button', {
              key: 'intel',
              className: `wk-dock-item ${workTab === 'intel' && !managementOpen ? 'active' : ''}`,
              'aria-pressed': workTab === 'intel' && !managementOpen,
              'aria-label': 'Social Intel Reader',
              onClick: () => { setWorkTab('intel'); setManagementOpen(false); setAudioPopoverOpen(false); setShowConversation(true); },
            }, [h(SvgIcon, { path: Icons.Globe, size: 20 }), h('span', { className: 'wk-dock-label' }, 'Intel')]),
            h('button', {
              key: 'settings',
              className: `wk-dock-item wk-dock-settings ${managementOpen ? 'active' : ''}`,
              'aria-expanded': managementOpen,
              'aria-controls': 'wk-settings',
              'aria-label': 'Open settings',
              onClick: () => { setManagementOpen(!managementOpen); setShowConversation(true); },
            }, [h(SvgIcon, { path: Icons.Settings, size: 20 }), h('span', { className: 'wk-dock-label' }, 'Settings')]),
          ]),
          h('aside', { className: 'wk-rail', hidden: !showContextualRail, 'aria-label': 'Conversations and workspace' }, [
            workTab === 'mesh' && !managementOpen && h(RepoRailSection, {
              recentWorkspaces,
              workspaceDir,
              repoStatus,
              recentStatuses,
              repoDiff,
              selectedDiffFile,
              onSelectDiffFile: file => setSelectedDiffFile(cur => cur === file ? '' : file),
              onStageFile: handleStageFile,
              onUnstageFile: handleUnstageFile,
              onStageAll: handleStageAll,
              onUnstageAll: handleUnstageAll,
              onDiscardFile: handleDiscardFile,
              onPickFolder: handlePickFolder,
              onSelectRepository: selectRepository,
              onRemoveRepository: handleRemoveRepository,
            }),
            h('div', { className: 'wk-rail-search', hidden: workTab === 'mesh' && !managementOpen }, [
              h('input', {
                type: 'search',
                className: 'wk-input',
                'aria-label': 'Search',
                placeholder: 'Search',
                value: conversationSearch,
                onChange: e => setConversationSearch(e.target.value),
                onKeyDown: e => {
                  if (e.key === 'Enter') {
                    const q = conversationSearch.trim().replace(/^@+/, '');
                    if (!q) return;
                    if (chatUserResults.length > 0 && visiblePeers.length === 0) {
                      e.preventDefault();
                      handleLinkPeer(chatUserResults[0].username);
                    } else if (visiblePeers.length === 0 && /^[a-zA-Z0-9-]{2,39}$/.test(q)) {
                      e.preventDefault();
                      handleLinkPeer(q);
                    }
                  }
                },
              }),
              h('div', { className: 'wk-conversation-filters', 'aria-label': 'Conversation filters' }, ['chats', 'channels', 'notes'].map(filter => h('button', { key: filter, className: `wk-filter-btn ${conversationFilter === filter ? 'active' : ''}`, 'aria-pressed': conversationFilter === filter, onClick: () => setConversationFilter(filter) }, { chats: 'Chats', channels: 'Channels', notes: 'Notes' }[filter]))),
            ]),
            h('div', { className: 'wk-conversations', hidden: workTab === 'mesh' && !managementOpen }, [
              conversationFilter === 'channels' && h(ChatChannels, { channels, activePeer, query: conversationSearch, onSelect: selectConversation, onCreate: peer => { saveChannels(channels.some(p => p.peerToken === peer.peerToken) ? channels : [...channels, peer]); selectConversation(peer); } }),
              conversationFilter === 'notes' && h('section', { 'aria-label': 'Personal Notes' }, [
                h('div', { className: 'wk-list-heading' }, [
                  h('span', null, 'Notes'),
                  h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: handleCreateNewNote, title: 'Create new note' }, '+ New'),
                ]),
                ...notesList.filter(n => n.title.toLowerCase().includes(conversationSearch.toLowerCase().trim())).map(note => h('button', {
                  key: note.id,
                  className: `wk-peer-item ${activePeer?.peerToken === note.id ? 'active' : ''}`,
                  'aria-pressed': activePeer?.peerToken === note.id,
                  onClick: () => selectConversation({ peerToken: note.id, alias: note.title, isNote: true, status: 'online' }),
                }, [
                  h('span', { className: 'wk-avatar-wrap' }, [h('span', { className: 'wk-avatar-fallback', 'aria-hidden': true }, h(SvgIcon, { path: Icons.Edit, size: 14 }))]),
                  h('span', { className: 'wk-peer-info' }, [
                    h('span', { className: 'wk-peer-name' }, note.title),
                    h('span', { className: 'wk-peer-sub' }, new Date(note.updatedAt).toLocaleDateString()),
                  ]),
                ])),
                !notesList.length && h('p', { className: 'wk-list-empty' }, 'No notes yet. Click + New to create one.'),
              ]),
              conversationFilter === 'chats' && h('section', { 'aria-label': 'Collaborators' }, [
                h('div', { className: 'wk-list-heading' }, [h('span', null, 'Collaborators')]),
                ...visiblePeers.map(peer => {
                  const displayName = formatPeerDisplayName(peer);
                  const isPeerPinned = pinnedSet.has(peerKeyOf(peer));
                  return h('button', {
                    key: peer.peerToken,
                    className: `wk-peer-item ${activePeer?.peerToken === peer.peerToken ? 'active' : ''}`,
                    'aria-pressed': activePeer?.peerToken === peer.peerToken,
                    onClick: () => selectConversation(peer),
                    onContextMenu: e => {
                      e.preventDefault();
                      e.stopPropagation();
                      const maxX = typeof window !== 'undefined' ? Math.max(8, window.innerWidth - 188) : e.clientX;
                      const maxY = typeof window !== 'undefined' ? Math.max(8, window.innerHeight - 130) : e.clientY;
                      setPeerContextMenu({ peer, x: Math.min(e.clientX, maxX), y: Math.min(e.clientY, maxY) });
                    },
                  }, [
                    h('span', { className: 'wk-avatar-wrap' }, [h('span', { className: 'wk-avatar-fallback', 'aria-hidden': true }, displayName.replace(/^@+/, '').slice(0, 2).toUpperCase()), peer.username && peer.avatarUrl && h('img', { className: 'wk-avatar-img', src: peer.avatarUrl, alt: '', onError: e => { e.target.style.display = 'none'; } }), h('span', { className: `wk-status-dot ${peer.status === 'online' ? 'online' : 'offline'}` })]),
                    h('span', { className: 'wk-peer-info' }, [
                      h('span', { className: 'wk-peer-name', style: { display: 'flex', alignItems: 'center', gap: 5 } }, [
                        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, displayName),
                        isPeerPinned && h(SvgIcon, { path: ChatGlyphs.pin, size: 11 }),
                      ]),
                      h('span', { className: 'wk-peer-sub' }, peer.status === 'online' ? 'Online' : 'Offline'),
                    ]),
                  ]);
                }),
                !visiblePeers.length && !conversationSearch.trim() && h('p', { className: 'wk-list-empty' }, 'No collaborators yet. Search a GitHub username above to connect.'),
              ]),
              conversationSearch.trim() && searchingUsers && h('p', { className: 'wk-list-empty' }, 'Searching GitHub...'),
              conversationSearch.trim() && chatUserResults.length > 0 && h('section', { 'aria-label': 'GitHub users' }, [
                h('div', { className: 'wk-rail-search-group' }, 'GitHub Users'),
                ...chatUserResults.map(u => h('button', { key: `gh-${u.username}`, className: 'wk-peer-item', onClick: () => handleLinkPeer(u.username) }, [
                  h('span', { className: 'wk-avatar-wrap' }, [h('span', { className: 'wk-avatar-fallback', 'aria-hidden': true }, u.username.slice(0, 2).toUpperCase()), u.avatarUrl && h('img', { className: 'wk-avatar-img', src: u.avatarUrl, alt: '' })]),
                  h('span', { className: 'wk-peer-info' }, [h('span', { className: 'wk-peer-name' }, `@${u.username}`), h('span', { className: 'wk-peer-sub' }, 'Connect & chat')]),
                ])),
              ]),
              conversationSearch.trim() && chatSearchMessages.length > 0 && h('section', { 'aria-label': 'Matching messages' }, [
                h('div', { className: 'wk-rail-search-group' }, 'Messages'),
                ...chatSearchMessages.map(m => h('button', { key: `msg-hit-${m.roomId}-${m.id}`, className: 'wk-peer-item', onClick: () => openRoomFromSearch(m) }, [
                  h('span', { className: 'wk-avatar-wrap' }, [h('span', { className: 'wk-avatar-fallback', 'aria-hidden': true }, h(SvgIcon, { path: Icons.Chat, size: 14 }))]),
                  h('span', { className: 'wk-peer-info' }, [h('span', { className: 'wk-peer-name' }, m.senderName), h('span', { className: 'wk-peer-sub' }, String(m.content || '').slice(0, 48))]),
                ])),
              ]),
            ]),
          ]),
          managementOpen && h(SettingsPanel, {
            auth,
            patInput,
            setPatInput,
            patBusy,
            deviceAuth,
            onStartDeviceLogin: handleStartDeviceLogin,
            onCancelDeviceLogin: handleCancelDeviceLogin,
            pendingInvites,
            onAcceptInvite: handleAcceptInvite,
            workConfig,
            setWorkConfig,
            configDirty: workConfig.defaultParent !== savedWorkConfig.defaultParent || workConfig.machineName !== savedWorkConfig.machineName || workConfig.vaultRepo !== savedWorkConfig.vaultRepo,
            onPickDefaultParent: handlePickDefaultParent,
            onSaveConfig: handleSaveConfig,
            showBubble,
            onToggleBubble: handleToggleBubble,
            busy,
            realtimeStatus,
            updateInfo,
            isHost,
            publishingUpdate,
            restartingUpdate,
            onPublishUpdate: handlePublishUpdate,
            onRestartToUpdate: handleRestartToUpdate,
            onCheckUpdate: () => checkUpdatesSilent(false),
            onClose: () => { setManagementOpen(false); if (typeof workSurface !== 'undefined' && workSurface.activeTab === 'settings') workSurface.setTab(workTab || 'messages'); },
            onConnectGithub: handleConnectGithub,
            onDisconnectGithub: handleDisconnectGithub,
          }),
          h('main', { hidden: managementOpen || workTab === 'music', className: `wk-center ${dropActive ? 'drop-active' : ''}`, onDragOver: e => { if (workTab === 'mesh') { e.preventDefault(); setDropActive(true); } }, onDragLeave: () => setDropActive(false), onDrop: handleDrop }, [
            workTab === 'messages' && activePeer?.isNote && h('div', { className: 'wk-mini-back-bar' }, [
              h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-back', onClick: () => setShowConversation(false), 'aria-label': 'Back to conversation list' }, h(SvgIcon, { path: 'M15 18l-6-6 6-6', size: 18 })),
              h('span', { style: { fontSize: 13, fontWeight: 600, color: 'var(--wk-text)' } }, conversationLabel),
            ]),
            workTab === 'mesh' && h(RepoMeshToolbar, {
              workspaceDir,
              repoFolderBasename,
              activePeer,
              peerList,
              channels,
              selectedRecipients: selectedShareRecipients,
              onToggleRecipient: toggleShareRecipient,
              activeRoomId,
              repoStatus,
              repoDiff,
              customCommitMessage,
              setCustomCommitMessage,
              onCommitAndShare: handleCommitAndShare,
              onCommit: handleCommitRepository,
              isEmbedded,
              busy,
              onPickFolder: handlePickFolder,
              onSelectPeer: selectConversation,
              onInspectDiff: handleInspectDiff,
              onBack: () => setShowConversation(false),
              headerActions: workspaceDir ? h(RepoHeaderActions, {
                busy,
                repoStatus,
                repoOverview,
                deployments,
                onSync: handleSyncRepository,
                onInspectDiff: handleInspectDiff,
                onSwitchBranch: handleSwitchBranch,
                onCreateBranch: handleCreateBranch,
                onPublishGithub: handlePublishGithub,
                onPushOrigin: handlePushOrigin,
              }) : null,
            }),
            workTab === 'mesh' && repoError && h('div', { className: 'wk-repo-error', role: 'alert' }, [h('p', null, repoError), h('button', { className: 'wk-btn wk-btn-secondary', onClick: handlePickFolder }, 'Choose repository')]),
            workTab === 'mesh' && !workspaceDir && h('section', { className: 'wk-repo-dropzone' + (dropActive ? ' active' : ''), 'aria-label': 'Open local repository', onDragOver: e => { e.preventDefault(); setDropActive(true); }, onDrop: handleDrop }, [h(SvgIcon, { path: Icons.Folder, size: 28 }), h('h2', null, 'Drop a repository folder'), h('p', null, 'Open a local Git repository to inspect, push to GitHub/Vercel, and share.'), h('button', { className: 'wk-btn wk-btn-secondary', onClick: handlePickFolder }, 'Choose repository')]),
            workTab === 'intel' && h(IntelReaderView, { connection, onSaveToNote: handleSaveIntelToNote, notify, onBack: () => setShowConversation(false) }),
            workTab === 'messages' && activePeer?.isNote && h(NotesBrainstormView, {
              note: notesList.find(n => n.id === activePeer.peerToken),
              onUpdateNote: updated => saveNotes(notesList.map(n => n.id === updated.id ? updated : n)),
              onExportMarkdown: () => handleExportActiveNote(notesList.find(n => n.id === activePeer.peerToken)),
              attachedFiles,
              onAttachFiles: handleAttachFiles,
              onRemoveAttachedFile: handleRemoveAttachedFile,
              fileInputRef,
            }),
            workTab === 'mesh' && workspaceDir && h('div', { className: `wk-mesh-workbench ${(filteredMessages.length || commandResult) ? '' : 'single-pane'}` }, [
              h('div', { className: 'wk-mesh-diff-pane' }, [
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } }, [
                  h('strong', { style: { fontSize: 12, color: 'var(--wk-text)' } }, selectedDiffFile ? `Diff: ${selectedDiffFile}` : `Working Tree (${repoStatus?.totalChanges || 0} changes)`),
                  selectedDiffFile && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setSelectedDiffFile('') }, 'All files'),
                ]),
                (() => {
                  const chosen = selectedDiffFile ? repoDiff?.files?.find(f => f.file === selectedDiffFile)?.diffText : repoDiff?.diffText;
                  return chosen
                    ? h(DiffPreview, { key: selectedDiffFile || 'all', text: chosen })
                    : h('div', { className: 'wk-empty-state' }, [
                        h('div', { className: 'wk-empty-title' }, 'Working tree clean'),
                        h('p', { className: 'wk-empty-sub' }, repoOverview?.githubRemote ? `${repoOverview.githubRemote.owner}/${repoOverview.githubRemote.repo}` : 'Ready to commit or push.'),
                      ]);
                })(),
              ]),
              (filteredMessages.length > 0 || commandResult) && h('div', { ref: streamRef, className: 'wk-mesh-cards-pane', role: 'log', 'aria-label': 'Shared repositories' }, [
                commandResult && h(RepoCard, { message: { content: `${commandResult.kind}: ${commandResult.transport || 'completed'}` }, meta: commandResult, hasLocal: Boolean(findLocalRepoForCard(commandResult)), busy, onClone: handleCloneCard, onDiff: handleInspectDiff, onMerge: handlePullAndMerge, onPush: handleCommitAndPush }),
                ...filteredMessages.map(m => h(RepoCard, { key: m.id, message: m, meta: m.fileMeta || {}, hasLocal: Boolean(findLocalRepoForCard(m.fileMeta || {})), busy, onClone: handleCloneCard, onDiff: handleInspectDiff, onMerge: handlePullAndMerge, onPush: handleCommitAndPush })),
              ]),
            ]),
            workTab === 'messages' && !activePeer?.isNote && h('button', {
              ref: managementToggleRef,
              type: 'button',
              className: 'wk-btn wk-btn-secondary wk-btn-sm wk-chat-drawer-fab',
              'aria-label': 'Chat management',
              'aria-expanded': managementDrawerOpen,
              title: 'Profile, Pinned & Shared Files',
              onClick: () => setManagementDrawerOpen(open => !open),
            }, [h(SvgIcon, { path: Icons.Chat, size: 13 }), h('span', null, conversationLabel)]),
            workTab === 'messages' && !activePeer?.isNote && commandResult && h(RepoCard, { message: { content: `${commandResult.kind}: ${commandResult.transport || 'completed'}` }, meta: commandResult, hasLocal: Boolean(workspaceDir), busy, onClone: handleCloneCard, onDiff: handleInspectDiff, onMerge: handlePullAndMerge, onPush: handleCommitAndPush }),
            workTab === 'messages' && !activePeer?.isNote && h('div', {
              ref: streamRef,
              className: 'wk-stream',
              role: 'log',
              'aria-label': 'Conversation messages',
              onScroll: e => {
                const el = e.currentTarget;
                wasNearBottomRef.current = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
              },
            }, [
              h('div', { key: 'stream-spacer', style: { flex: 1 } }),
              ...(filteredMessages.length ? filteredMessages.flatMap((m, idx) => {
                const isMe = m.sender === profile?.machineToken || (myGithubLogin && m.senderGithub?.toLowerCase() === myGithubLogin.toLowerCase());
                const day = m.created_at ? new Date(m.created_at).toDateString() : '';
                const prevDay = idx > 0 && filteredMessages[idx - 1]?.created_at ? new Date(filteredMessages[idx - 1].created_at).toDateString() : '';
                const nodes = [];
                if (day && day !== prevDay) {
                  nodes.push(h('div', { key: `date-${day}-${idx}`, className: 'wk-chat-date-divider' }, h('span', null, new Date(m.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }))));
                }
                if (m.type === 'repo-card') {
                  nodes.push(h(RepoCard, { key: m.id, message: m, meta: m.fileMeta || {}, hasLocal: Boolean(findLocalRepoForCard(m.fileMeta || {})), busy, onClone: handleCloneCard, onDiff: handleInspectDiff, onMerge: handlePullAndMerge, onPush: handleCommitAndPush }));
                } else {
                  nodes.push(h(DiscordMessageRow, { key: m.id, message: m, isMe, peer: activePeer, peerDisplayName: activePeer?.isChannel ? '' : activePeerDisplay, profile, connection, notify, onAction: handleChatAction, onReply: message => { setReplyTo(message); composerRef.current?.focus(); }, onDelete: requestDeleteMessage }));
                }
                return nodes;
              }) : [h('div', { key: 'empty', className: 'wk-empty-state' }, [h('div', { className: 'wk-empty-title' }, `Start the conversation in ${conversationLabel}`), h('p', { className: 'wk-empty-sub' }, 'Type a message below, attach files, or use /diff and /commit.')])]),
            ]),
            workTab === 'messages' && !activePeer?.isNote && pendingDeletes.length > 0 && h('div', { className: 'wk-revert-delete-stack', role: 'status', 'aria-live': 'polite' }, pendingDeletes.map(item => {
              const r = 9;
              const circ = 2 * Math.PI * r;
              const offset = circ * (1 - item.remaining / 5);
              return h('button', {
                key: item.id,
                type: 'button',
                className: 'wk-revert-delete-pill',
                onClick: () => revertDeleteMessage(item.id),
                'aria-label': `Revert Delete (${item.remaining}s)`,
              }, [
                h('span', null, 'Revert Delete'),
                h('span', { className: 'wk-revert-ring', 'aria-hidden': true }, [
                  h('svg', { width: 22, height: 22, viewBox: '0 0 22 22' }, [
                    h('circle', { cx: 11, cy: 11, r, fill: 'none', stroke: 'rgba(255,255,255,0.18)', strokeWidth: 2 }),
                    h('circle', { cx: 11, cy: 11, r, fill: 'none', stroke: '#38bdf8', strokeWidth: 2, strokeDasharray: circ, strokeDashoffset: offset, strokeLinecap: 'round' }),
                  ]),
                  h('span', null, String(item.remaining)),
                ]),
              ]);
            })),
            workTab === 'messages' && !activePeer?.isNote && h('form', { className: 'wk-composer', onSubmit: e => { e.preventDefault(); handleSendMessage(); } }, [
              replyTo && h('div', { className: 'wk-composer-reply' }, [h('span', null, `Replying to ${replyTo.senderName || 'Collaborator'}: ${(replyTo.content || 'Attachment').slice(0, 100)}`), h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', 'aria-label': 'Cancel reply', onClick: () => setReplyTo(null) }, h(SvgIcon, { path: Icons.Close, size: 14 }))]),
              recordingVoice && h('div', { className: 'wk-voice-controls' }, [h('span', { role: 'timer', 'aria-label': 'Recording duration' }, `Recording ${String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}:${String(recordingSeconds % 60).padStart(2, '0')}`), h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', onClick: () => stopVoice(false) }, 'Cancel'), h('button', { type: 'button', className: 'wk-btn wk-btn-primary', onClick: () => stopVoice(true) }, 'Send')]),
              attachedFiles.length > 0 && h('div', { className: 'wk-attached-pills' },
                attachedFiles.map((f, idx) => h('span', { key: idx, className: 'wk-file-pill' }, [
                  h(SvgIcon, { path: Icons.Attach, size: 12 }),
                  h('span', { className: 'wk-file-pill-name' }, f.name),
                  h('button', { type: 'button', className: 'wk-pill-remove', onClick: () => handleRemoveAttachedFile(idx) }, '×'),
                ]))
              ),
              h('div', { className: 'wk-composer-input-row' }, [
                h('input', { type: 'file', ref: fileInputRef, style: { display: 'none' }, multiple: true, onChange: handleAttachFiles }),
                h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-back', onClick: () => setShowConversation(false), 'aria-label': 'Back to conversation list' }, h(SvgIcon, { path: 'M15 18l-6-6 6-6', size: 16 })),
                h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-attach', title: 'Attach files', 'aria-label': 'Attach files', onClick: () => fileInputRef.current && fileInputRef.current.click() }, h(SvgIcon, { path: Icons.Plus, size: 18 })),
                h('textarea', { ref: composerRef, rows: 1, className: 'wk-input', onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSendMessage(); } }, 'aria-label': 'Message or Git slash command', placeholder: activePeer ? `Message ${conversationLabel}` : 'Select a conversation to write a message', value: messageInput, disabled: !activeRoomId && !activePeer?.isNote, onChange: e => setMessageInput(e.target.value) }),
                h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', disabled: !activeRoomId || busy || recordingVoice, 'aria-label': 'Record voice note', title: 'Record voice note', onClick: startVoice }, h(SvgIcon, { path: ChatGlyphs.mic, size: 17 })),
                h('button', { type: 'submit', className: 'wk-btn wk-btn-primary', disabled: busy || recordingVoice || (!activeRoomId && !activePeer?.isNote) || (!messageInput.trim() && !attachedFiles.length), 'aria-label': 'Send message' }, h(SvgIcon, { path: Icons.Send, size: 17 })),
              ]),
            ]),
          ]),
          h('div', { className: `wk-player-slot ${workTab === 'music' && !managementOpen ? 'is-music-tab' : ''}`, hidden: managementOpen }, [
            h(ItunesPlayer, { key: 'persistent-player', connection, musicActive: workTab === 'music', popoverOpen: workTab === 'music' || audioPopoverOpen, setPopoverOpen: setAudioPopoverOpen, onOpenSearch: () => { setWorkTab('music'); setManagementOpen(false); } }),
          ]),
          workTab === 'messages' && !managementOpen && !activePeer?.isNote && managementDrawerOpen && h(ChatManagementDrawer, { messages, peer: activePeer, peerDisplayName: conversationLabel, onSaveNickname: handleSavePeerNickname, connection, notify, onAction: handleChatAction, onDeleteFile: handleDeleteChatFile, onClose: () => { setManagementDrawerOpen(false); managementToggleRef.current?.focus(); } }),
        ]),
        drawerOpen && h(DiffInspectorDrawer, { drawerDiff, loading: drawerLoading, onClose: () => setDrawerOpen(false) }),
        conflicts.length > 0 && h(MergeConflictModal, { conflicts, onAbort: handleAbortMerge, onComplete: handleCompleteMerge, onResolve: handleResolveConflict }),
        peerContextMenu && h('div', {
          className: 'wk-peer-context-menu',
          role: 'menu',
          'aria-label': 'Collaborator actions',
          style: { left: peerContextMenu.x, top: peerContextMenu.y },
          onClick: e => e.stopPropagation(),
        }, [
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'wk-peer-context-item',
            onClick: () => { togglePinPeer(peerContextMenu.peer); setPeerContextMenu(null); },
          }, [h(SvgIcon, { path: ChatGlyphs.pin, size: 13 }), pinnedSet.has(peerKeyOf(peerContextMenu.peer)) ? 'Unpin' : 'Pin']),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'wk-peer-context-item',
            onClick: () => { const target = peerContextMenu.peer; setPeerContextMenu(null); handleUnlinkPeer(target, false); },
          }, [h(SvgIcon, { path: Icons.Close, size: 13 }), 'Unlink']),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'wk-peer-context-item danger',
            onClick: () => { const target = peerContextMenu.peer; setPeerContextMenu(null); handleUnlinkPeer(target, true); },
          }, [h(SvgIcon, { path: ChatGlyphs.trash, size: 13 }), 'Unlink & Delete Chat']),
        ]),
      ]);
    }
