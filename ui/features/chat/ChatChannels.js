    function chatMessageId(id) { return `wk-chat-${encodeURIComponent(id)}`; }
    function stripInlineMarkdown(text) {
      return String(text || '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1');
    }
    function jumpToChatMessage(id) {
      const node = document.getElementById(chatMessageId(id));
      node?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      node?.focus({ preventScroll: true });
    }
    function channelPeer(name) {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-+|-+$/g, '');
      return slug ? { peerToken: `channel:${slug}`, alias: slug, isChannel: true } : null;
    }
    const attachmentSourceCache = new Map();
    function formatSafeTime(value) {
      const date = new Date(value || 0);
      if (Number.isNaN(date.getTime())) return { iso: '', label: '--:--' };
      return { iso: date.toISOString(), label: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    }
    function formatAudioClock(sec) {
      const s = Math.max(0, Math.floor(Number(sec) || 0));
      const m = Math.floor(s / 60);
      return `${m}:${String(s % 60).padStart(2, '0')}`;
    }
    function CompactAudioPill({ source, loading, error }) {
      const audioRef = typeof useRef === 'function' ? useRef(null) : { current: null };
      const [playing, setPlaying] = useState(false);
      const [currentTime, setCurrentTime] = useState(0);
      const [duration, setDuration] = useState(0);
      const [muted, setMuted] = useState(false);
      const togglePlay = () => {
        const el = audioRef.current;
        if (!el || !source) return;
        if (el.paused) el.play?.().catch?.(() => {});
        else el.pause?.();
      };
      const toggleMute = () => {
        const el = audioRef.current;
        const next = !muted;
        if (el) el.muted = next;
        setMuted(next);
      };
      return h('div', { className: 'wk-audio-pill', 'aria-label': 'Voice note playback' }, [
        source && h('audio', {
          ref: audioRef,
          src: source,
          preload: 'metadata',
          style: { display: 'none' },
          onLoadedMetadata: e => { if (Number.isFinite(e.target.duration)) setDuration(e.target.duration); },
          onTimeUpdate: e => { setCurrentTime(e.target.currentTime || 0); },
          onPlay: () => setPlaying(true),
          onPause: () => setPlaying(false),
          onEnded: () => { setPlaying(false); setCurrentTime(0); },
        }),
        h('button', {
          type: 'button',
          className: 'wk-btn wk-btn-subtle wk-audio-pill-btn',
          disabled: loading || !source,
          onClick: togglePlay,
          'aria-label': playing ? 'Pause voice note' : 'Play voice note',
        }, h(SvgIcon, { path: playing ? Icons.Pause : Icons.Play, size: 12 })),
        h('input', {
          type: 'range',
          className: 'wk-audio-pill-seek',
          min: 0,
          max: duration || 1,
          step: 0.1,
          value: Math.min(currentTime, duration || 1),
          disabled: !source || !duration,
          'aria-label': 'Voice note progress',
          onChange: e => {
            const val = Number(e.target.value);
            setCurrentTime(val);
            if (audioRef.current) audioRef.current.currentTime = val;
          },
        }),
        h('span', { className: 'wk-audio-pill-time' }, formatAudioClock(playing || currentTime > 0 ? currentTime : duration)),
        h('button', {
          type: 'button',
          className: 'wk-btn wk-btn-subtle wk-audio-pill-btn',
          style: { opacity: muted ? 0.45 : 0.85 },
          onClick: toggleMute,
          'aria-label': muted ? 'Unmute voice note' : 'Mute voice note',
        }, h(SvgIcon, { path: Icons.Volume, size: 12 })),
        error && h('span', { role: 'status', className: 'wk-peer-sub' }, error),
      ]);
    }
    function ChatAttachment({ message, connection, notify, compact = false }) {
      const meta = message.fileMeta;
      const [source, setSource] = useState('');
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState('');
      const mime = meta?.mimeType || meta?.type || '';
      const image = /^image\/(png|jpeg|gif|webp|avif)$/i.test(mime);
      const video = /^video\/(webm|mp4|ogg)$/i.test(mime);
      const audio = message.type === 'voice' || /^audio\//i.test(mime);
      const load = async () => {
        if (!meta || meta.deletedAt) return '';
        const cacheKey = meta.filePath || meta.url || '';
        if (cacheKey && attachmentSourceCache.has(cacheKey)) {
          try {
            const cachedUrl = await attachmentSourceCache.get(cacheKey);
            setSource(cachedUrl);
            return cachedUrl;
          } catch (err) {
            attachmentSourceCache.delete(cacheKey);
            setError(err.message);
            return '';
          }
        }
        setLoading(true); setError('');
        const task = (async () => {
          if (meta.filePath) {
            const res = await callWorkRpc(connection, 'readAttachmentFile', { filePath: meta.filePath });
            if (!res?.ok) throw new Error(res?.error?.message || 'Attachment could not be loaded.');
            return `data:${res.value.mimeType};base64,${res.value.rawBase64}`;
          }
          if (/^https:\/\//i.test(meta.url || '')) return meta.url;
          throw new Error('Attachment is unavailable on this machine.');
        })();
        if (cacheKey) {
          if (attachmentSourceCache.size >= 40) attachmentSourceCache.delete(attachmentSourceCache.keys().next().value);
          attachmentSourceCache.set(cacheKey, task);
        }
        try {
          const url = await task;
          setSource(url); return url;
        } catch (err) {
          if (cacheKey) attachmentSourceCache.delete(cacheKey);
          setError(err.message); return '';
        } finally { setLoading(false); }
      };
      useEffect(() => { setSource(''); setError(''); if (meta && !meta.deletedAt && (image || video || audio)) load(); }, [meta?.filePath, meta?.url, meta?.deletedAt]);
      if (!meta) return null;
      if (meta.deletedAt) return h('span', { className: 'wk-peer-sub' }, 'Attachment deleted');
      if (audio) return h(CompactAudioPill, { source, loading, error });
      return h('div', { className: `wk-chat-attachment ${compact ? 'compact' : ''}` }, [
        source && image && h('a', { href: source, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `View ${meta.name}` }, h('img', { src: source, alt: meta.name || 'Shared image', loading: 'lazy' })),
        source && video && h('video', { src: source, controls: true, preload: 'metadata', 'aria-label': meta.name || 'Shared video' }),
        h('span', { className: 'wk-chat-file-name' }, meta.name || 'Attachment'),
        h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: loading, onClick: async () => {
          const url = source || await load(); if (!url) return;
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = meta.name || 'attachment'; anchor.rel = 'noopener noreferrer'; anchor.click();
        } }, loading ? 'Loading...' : 'Download'),
        error && h('span', { role: 'status', className: 'wk-peer-sub' }, error),
      ]);
    }
    function DiscordMessageRow({ message: m, isMe, peer, peerDisplayName = '', profile, connection, notify, onAction, onReply, onDelete }) {
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState(m.content || '');
      const pending = String(m.id).startsWith('temp-');
      const button = (label, path, action, pressed) => h('button', { key: label, type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', title: label, 'aria-label': label, 'aria-pressed': pressed, disabled: pending, onClick: action }, h(SvgIcon, { path, size: 16 }));
      const copy = () => copyChatText(m.content || '').catch(err => notify(err.message, 'error'));
      const safeTime = formatSafeTime(m.created_at);
      const cleanAuthor = isMe
        ? (profile?.githubUsername ? `@${String(profile.githubUsername).replace(/^@+/, '')}` : 'You')
        : (peerDisplayName || m.senderName || 'Collaborator');
      const fireTokens = Array.isArray(m.reactions?.fire) ? m.reactions.fire : [];
      const myActorTokens = [profile?.githubUsername, profile?.machineToken].filter(Boolean).map(t => String(t).toLowerCase());
      const firePressed = fireTokens.some(t => myActorTokens.includes(String(t).toLowerCase()));
      return h('article', { id: chatMessageId(m.id), tabIndex: -1, className: `wk-discord-row ${m.isPinned ? 'pinned' : ''} ${isMe ? 'mine' : 'theirs'}` }, [
        h('div', { className: 'wk-chat-avatar', 'aria-label': isMe || peer?.status === 'online' ? 'Online' : 'Offline' }, [h('span', null, cleanAuthor.replace(/^@+/, '').slice(0, 2).toUpperCase()), h('span', { className: `wk-status-dot ${isMe || peer?.status === 'online' ? 'online' : 'offline'}` })]),
        h('div', { className: 'wk-chat-body' }, [
          m.replyTo && h('button', { className: 'wk-reply-quote', onClick: () => jumpToChatMessage(m.replyTo.id) }, `${(m.replyTo.sender && (m.replyTo.sender === profile?.machineToken || m.replyTo.sender === profile?.githubUsername)) ? 'You' : `@${String(m.replyTo.senderName || 'Collaborator').replace(/^@+/, '')}`}: ${stripInlineMarkdown(m.replyTo.content || 'Attachment').slice(0, 140)}`),
          h('header', { className: 'wk-chat-meta' }, [
            h('strong', null, cleanAuthor),
            h('time', { dateTime: safeTime.iso }, safeTime.label),
            m.isPinned && h(SvgIcon, { path: ChatGlyphs.pin, size: 12 }),
            m.isEdited && h('span', { title: m.editedAt }, '(edited)'),
          ]),
          editing ? h('form', { className: 'wk-chat-edit', onSubmit: async e => { e.preventDefault(); if (await onAction('editChatMessage', m, { newContent: draft })) setEditing(false); } }, [h('textarea', { className: 'wk-input', 'aria-label': 'Edit message', value: draft, onChange: e => setDraft(e.target.value), onKeyDown: e => { if (e.key === 'Escape') setEditing(false); }, autoFocus: true }), h('button', { type: 'submit', className: 'wk-btn wk-btn-primary', disabled: !draft.trim() }, 'Save'), h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', onClick: () => setEditing(false) }, 'Cancel')]) : (m.content ? h('div', { className: 'wk-msg-text' }, renderMessageMarkdown(m.content)) : null),
          m.fileMeta && h(ChatAttachment, { message: m, connection, notify }),
          fireTokens.length > 0 && h('div', { className: 'wk-chat-reactions' }, [
            h('button', {
              key: 'fire',
              className: `wk-btn wk-btn-subtle wk-btn-sm ${firePressed ? 'active' : ''}`,
              'aria-label': `fire: ${fireTokens.length}`,
              'aria-pressed': firePressed,
              onClick: () => onAction('reactChatMessage', m, { reaction: 'fire' }),
            }, [h(SvgIcon, { path: ChatGlyphs.fire, size: 14 }), String(fireTokens.length)]),
          ]),
        ]),
        h('div', { className: 'wk-message-actions', role: 'group', 'aria-label': 'Message actions' }, [
          button('React fire', ChatGlyphs.fire, () => onAction('reactChatMessage', m, { reaction: 'fire' }), firePressed),
          button('Reply', ChatGlyphs.reply, () => onReply(m)),
          button(m.isPinned ? 'Unpin' : 'Pin', ChatGlyphs.pin, () => onAction('pinChatMessage', m, { isPinned: !m.isPinned }), !!m.isPinned),
          isMe
            ? button('Edit', Icons.Edit, () => { setDraft(m.content || ''); setEditing(true); })
            : button('Copy text', ChatGlyphs.copy, copy),
          isMe && button('Delete message', ChatGlyphs.trash, () => (onDelete ? onDelete(m) : onAction('deleteChatMessage', m))),
        ]),
      ]);
    }
    function ChatManagementDrawer({ messages, peer, peerDisplayName = '', onSaveNickname, connection, notify, onAction, onClose, onDeleteFile }) {
      const [nicknameInput, setNicknameInput] = useState(peer?.customAlias || '');
      useEffect(() => { setNicknameInput(peer?.customAlias || ''); }, [peer?.peerToken, peer?.customAlias]);
      const pinned = messages.filter(m => m.isPinned);
      const files = messages.filter(m => m.fileMeta && !m.fileMeta.deletedAt);
      const media = files.filter(m => /^(image|video)\//.test(m.fileMeta.mimeType || m.fileMeta.type || ''));
      const links = [...new Set(messages.flatMap(m => (m.content || '').match(/https?:\/\/[^\s<>"`]+/g) || []))];
      const titleText = peerDisplayName || peer?.alias || 'Conversation';
      const saveNick = (val) => {
        if (typeof onSaveNickname === 'function') onSaveNickname(peer, String(val ?? nicknameInput).trim());
      };
      return h('aside', { className: 'wk-management-drawer', 'aria-label': 'Chat management', onKeyDown: e => { if (e.key === 'Escape') onClose(); } }, [
        h('button', { className: 'wk-btn wk-btn-subtle wk-drawer-close-fab', 'aria-label': 'Close chat management', onClick: onClose, autoFocus: true }, h(SvgIcon, { path: Icons.Close, size: 16 })),
        h('div', { className: 'wk-management-body' }, [
          h('section', { className: 'wk-chat-info wk-discord-profile-card' }, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } }, [
              h('div', { className: 'wk-chat-avatar large', style: { marginTop: 0, width: 48, height: 48, fontSize: 16 } }, [
                peer?.avatarUrl
                  ? h('img', { src: peer.avatarUrl, alt: '', style: { width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' } })
                  : titleText.replace(/^[@#]+/, '').slice(0, 2).toUpperCase(),
                !peer?.isChannel && h('span', { className: `wk-status-dot ${peer?.status === 'online' ? 'online' : 'offline'}` }),
              ]),
              h('div', { style: { flex: 1, minWidth: 0 } }, [
                h('h3', { style: { fontSize: 15, margin: '0 0 2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, titleText),
                !peer?.isChannel && h('span', { className: 'wk-peer-sub' }, peer?.status === 'online' ? 'Online' : 'Offline'),
              ]),
            ]),
            !peer?.isChannel && h('form', {
              className: 'wk-nickname-form',
              onSubmit: e => { e.preventDefault(); saveNick(nicknameInput); },
            }, [
              h('input', {
                className: 'wk-input',
                'aria-label': 'Nickname',
                placeholder: peer?.username ? `Nickname for @${String(peer.username).replace(/^@+/, '')}` : 'Set nickname...',
                value: nicknameInput,
                maxLength: 48,
                onChange: e => setNicknameInput(e.target.value),
              }),
              h('button', { type: 'submit', className: 'wk-btn wk-btn-secondary wk-btn-sm' }, 'Save'),
              peer?.customAlias && h('button', {
                type: 'button',
                className: 'wk-btn wk-btn-subtle wk-btn-sm',
                onClick: () => { setNicknameInput(''); saveNick(''); },
              }, 'Reset'),
            ]),
          ]),
          h('section', null, [h('h3', null, `Pinned messages (${pinned.length})`), ...pinned.map(m => h('div', { key: m.id, className: 'wk-pinned-item' }, [h('button', { className: 'wk-btn wk-btn-subtle wk-pinned-jump', onClick: () => jumpToChatMessage(m.id) }, `${m.senderName || 'Peer'}: ${stripInlineMarkdown(m.content || m.fileMeta?.name || 'Attachment')}`), h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', 'aria-label': 'Unpin message', onClick: () => onAction('pinChatMessage', m, { isPinned: false }) }, h(SvgIcon, { path: ChatGlyphs.pin, size: 14 }))])), !pinned.length && h('p', { className: 'wk-peer-sub' }, 'None')]),
          h('section', null, [h('h3', null, `Photos / videos (${media.length})`), media.length ? h('div', { className: 'wk-media-grid' }, media.map(m => h(ChatAttachment, { key: m.id, message: m, connection, notify, compact: true }))) : h('p', { className: 'wk-peer-sub' }, 'None')]),
          h('details', { open: files.length > 0 }, [h('summary', null, `Files (${files.length})`), ...files.map(m => h('div', { className: 'wk-drawer-file', key: m.id }, [h(SvgIcon, { path: Icons.Attach, size: 16 }), h(ChatAttachment, { message: m, connection, notify, compact: true }), m.fileMeta.filePath && h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', 'aria-label': `Delete local file ${m.fileMeta.name}`, title: 'Permanently delete local file', onClick: () => onDeleteFile(m) }, h(SvgIcon, { path: ChatGlyphs.trash, size: 16 }))])), !files.length && h('p', { className: 'wk-peer-sub' }, 'None')]),
          links.length > 0 && h('details', null, [h('summary', null, `Links (${links.length})`), ...links.map(url => h('a', { key: url, className: 'wk-shared-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, url))]),
        ]),
      ]);
    }
    function ChatChannels({ channels, activePeer, onSelect, onCreate, query = '' }) {
      const [name, setName] = useState('');
      const [creating, setCreating] = useState(false);
      const visible = channels.filter(channel => channel.alias.toLowerCase().includes(query.toLowerCase().trim()));
      return h('section', { className: 'wk-channel-group', 'aria-label': 'Channels' }, [
        h('div', { className: 'wk-list-heading' }, [
          h('span', null, 'Channels'),
          h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', 'aria-label': 'Create channel', 'aria-expanded': creating, onClick: () => setCreating(!creating) }, h(SvgIcon, { path: Icons.Plus, size: 16 })),
        ]),
        ...visible.map(channel => h('button', {
          key: channel.peerToken, className: `wk-peer-item wk-channel ${activePeer?.peerToken === channel.peerToken ? 'active' : ''}`,
          onClick: () => onSelect(channel), 'aria-pressed': activePeer?.peerToken === channel.peerToken,
        }, [
          h('span', { className: 'wk-avatar-fallback', 'aria-hidden': true }, h(SvgIcon, { path: 'M4 9h16M3 15h16M10 3L6 21M18 3l-4 18', size: 20 })),
          h('span', { className: 'wk-peer-info' }, [h('span', { className: 'wk-peer-name' }, channel.alias)]),
        ])),
        !visible.length && h('p', { className: 'wk-list-empty' }, 'No matching channels.'),
        creating && h('form', { className: 'wk-search-row wk-channel-create', onSubmit: e => { e.preventDefault(); const peer = channelPeer(name); if (peer) { onCreate(peer); setName(''); setCreating(false); } } }, [
          h('input', { className: 'wk-input', 'aria-label': 'New channel name', placeholder: 'Channel name', maxLength: 48, value: name, onChange: e => setName(e.target.value) }),
          h('button', { className: 'wk-btn wk-btn-secondary', type: 'submit', disabled: !channelPeer(name) }, 'Create'),
        ]),
      ]);
    }
