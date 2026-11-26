    function droppedRepositoryPath(dataTransfer) {
      let path = dataTransfer?.files?.[0]?.path;
      if (typeof path !== 'string' || !path.trim()) {
        const uri = (dataTransfer?.getData?.('text/uri-list') || '').split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
        if (!uri) return null;
        try {
          const url = new URL(uri);
          if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
          path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
        } catch { return null; }
      }
      path = path.trim();
      if (/[\0\r\n]/.test(path)) return null;
      return /^(?:[a-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/i.test(path) ? path : null;
    }

    function RepoRailSection({
      recentWorkspaces,
      workspaceDir,
      repoStatus,
      recentStatuses,
      repoDiff,
      selectedDiffFile = '',
      onSelectDiffFile = () => {},
      onStageFile = () => {},
      onUnstageFile = () => {},
      onStageAll = null,
      onUnstageAll = null,
      onDiscardFile = () => {},
      onPickFolder,
      onSelectRepository,
      onRemoveRepository = null,
    }) {
      const stagedSet = new Set(repoStatus?.staged || []);
      const modifiedSet = new Set(repoStatus?.modified || []);
      const untrackedSet = new Set(repoStatus?.untracked || []);
      const changedFiles = [...new Set([...(repoStatus?.staged || []), ...(repoStatus?.modified || []), ...(repoStatus?.untracked || [])])];
      const unstagedFiles = changedFiles.filter(f => !stagedSet.has(f));
      const stagedFiles = [...stagedSet];

      return h('section', { className: 'wk-repo-rail', 'aria-label': 'Recent repositories and changes' }, [
        h('div', { className: 'wk-list-heading' }, [
          h('strong', null, 'Recent repos'),
          h('button', { className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: onPickFolder, 'aria-label': 'Open repository folder' }, h(SvgIcon, { path: Icons.Folder, size: 16 })),
        ]),
        ...recentWorkspaces.map(repoPath => {
          const status = repoPath === workspaceDir ? repoStatus : recentStatuses[repoPath];
          return h('div', {
            key: repoPath,
            className: `wk-peer-item ${repoPath === workspaceDir ? 'active' : ''}`,
            style: { alignItems: 'center', minHeight: 52, padding: '8px 10px', cursor: 'pointer' },
            role: 'button',
            tabIndex: 0,
            'aria-pressed': repoPath === workspaceDir,
            title: repoPath,
            onClick: () => onSelectRepository(repoPath),
            onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectRepository(repoPath); } },
          }, [
            h('span', { className: 'wk-peer-info', style: { flex: 1, minWidth: 0 } }, [
              h('strong', { className: 'wk-peer-name' }, repoPath.split(/[\\/]/).pop()),
              h('span', { className: 'wk-peer-sub' }, `${status?.branch || 'Not loaded'} · ${status?.totalChanges ?? '—'} files`),
            ]),
            onRemoveRepository && h('button', {
              type: 'button',
              className: 'wk-btn wk-btn-subtle wk-btn-sm',
              'aria-label': `Remove ${repoPath.split(/[\\/]/).pop()} from recent repos`,
              title: 'Remove from list',
              style: { minWidth: 22, width: 22, minHeight: 22, height: 22, padding: 0, flexShrink: 0 },
              onClick: e => { e.stopPropagation(); onRemoveRepository(repoPath); },
            }, h(SvgIcon, { path: Icons.Close, size: 11 })),
          ]);
        }),
        !recentWorkspaces.length && h('p', { className: 'wk-list-empty' }, 'Open a repository to keep it here.'),
        h('div', { className: 'wk-list-heading' }, [
          h('strong', null, `Changes (${changedFiles.length})`),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, [
            h('span', null, [h('span', { className: 'wk-git-add' }, `+${repoDiff?.totalAdditions || 0}`), ' ', h('span', { className: 'wk-git-remove' }, `-${repoDiff?.totalDeletions || 0}`)]),
            onStageAll && unstagedFiles.length > 0 && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', title: 'Stage all', 'aria-label': 'Stage all changes', onClick: () => onStageAll(unstagedFiles) }, '+All'),
            onUnstageAll && stagedFiles.length > 0 && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', title: 'Unstage all', 'aria-label': 'Unstage all changes', onClick: () => onUnstageAll(stagedFiles) }, '−All'),
          ]),
        ]),
        ...changedFiles.map(file => {
          const isStaged = stagedSet.has(file);
          const isUntracked = untrackedSet.has(file) && !modifiedSet.has(file);
          const badge = isStaged ? 'S' : (isUntracked ? 'U' : 'M');
          return h('div', {
            key: file,
            className: `wk-git-file-row ${selectedDiffFile === file ? 'active' : ''}`,
            onClick: () => onSelectDiffFile(file),
          }, [
            h('span', { className: `wk-git-file-badge ${badge}`, title: isStaged ? 'Staged' : isUntracked ? 'Untracked' : 'Modified' }, badge),
            h('span', { className: 'wk-git-file-name', title: file }, file),
            h('div', { className: 'wk-git-file-acts', onClick: e => e.stopPropagation() }, [
              isStaged
                ? h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', title: 'Unstage file', 'aria-label': `Unstage ${file}`, onClick: () => onUnstageFile(file) }, '−')
                : h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', title: 'Stage file', 'aria-label': `Stage ${file}`, onClick: () => onStageFile(file) }, '+'),
              h('button', {
                type: 'button',
                className: 'wk-btn wk-btn-subtle wk-btn-sm',
                title: 'Discard changes',
                'aria-label': `Discard ${file}`,
                onClick: () => { if (typeof window === 'undefined' || !window.confirm || window.confirm(`Discard changes to ${file}?`)) onDiscardFile(file); },
              }, h(SvgIcon, { path: Icons.Close, size: 11 })),
            ]),
          ]);
        }),
        workspaceDir && !changedFiles.length && h('p', { className: 'wk-list-empty' }, 'Working tree clean.'),
      ]);
    }

    function RepoHeaderActions({
      busy,
      repoStatus,
      repoOverview = null,
      deployments = [],
      onSync,
      onInspectDiff,
      onSwitchBranch = () => {},
      onCreateBranch = () => {},
      onPublishGithub = () => {},
      onPushOrigin = () => {},
    }) {
      const [creatingBranch, setCreatingBranch] = typeof useState === 'function' ? useState(false) : [false, () => {}];
      const [branchDraft, setBranchDraft] = typeof useState === 'function' ? useState('') : ['', () => {}];
      const branches = repoOverview?.branches || (repoStatus?.branch ? [repoStatus.branch] : []);
      const hasOrigin = Boolean(repoOverview?.githubRemote);
      const latestDeploy = deployments?.[0] || null;
      const submitBranch = (e) => {
        e?.preventDefault?.();
        const next = branchDraft.trim();
        if (!next) return;
        onCreateBranch(next);
        setBranchDraft('');
        setCreatingBranch(false);
      };
      return h('div', { className: 'wk-conversation-actions' }, [
        branches.length > 0 && h('select', {
          className: 'wk-input wk-mesh-select',
          'aria-label': 'Active branch',
          style: { maxWidth: 130, minHeight: 28, height: 28, fontSize: 11 },
          value: repoStatus?.branch || '',
          disabled: busy,
          onChange: e => { if (e.target.value && e.target.value !== repoStatus?.branch) onSwitchBranch(e.target.value); },
        }, branches.map(b => h('option', { key: b, value: b }, b))),
        creatingBranch
          ? h('form', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 }, onSubmit: submitBranch }, [
              h('input', {
                className: 'wk-input',
                'aria-label': 'New branch name',
                placeholder: 'feat/name',
                value: branchDraft,
                autoFocus: true,
                style: { width: 116, minHeight: 28, height: 28, fontSize: 11, padding: '2px 8px' },
                onChange: e => setBranchDraft(e.target.value),
                onKeyDown: e => { if (e.key === 'Escape') { setCreatingBranch(false); setBranchDraft(''); } },
              }),
              h('button', { type: 'submit', className: 'wk-btn wk-btn-primary wk-btn-sm', disabled: busy || !branchDraft.trim() }, 'Add'),
              h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', 'aria-label': 'Cancel branch', onClick: () => { setCreatingBranch(false); setBranchDraft(''); } }, h(SvgIcon, { path: Icons.Close, size: 11 })),
            ])
          : h('button', {
              type: 'button',
              className: 'wk-btn wk-btn-subtle wk-btn-sm',
              disabled: busy || !repoStatus?.isGit,
              title: 'Create & switch new branch',
              onClick: () => setCreatingBranch(true),
            }, '+ Branch'),
        latestDeploy?.targetUrl && h('a', {
          href: latestDeploy.targetUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: `wk-deploy-pill ${latestDeploy.state === 'pending' || latestDeploy.state === 'in_progress' ? 'building' : ''}`,
          title: `${latestDeploy.environment}: ${latestDeploy.state}`,
        }, `${latestDeploy.environment}: ${latestDeploy.state}`),
        hasOrigin
          ? h('button', {
              type: 'button',
              className: 'wk-btn wk-btn-secondary',
              disabled: busy,
              title: `Push HEAD to ${repoOverview.githubRemote.owner}/${repoOverview.githubRemote.repo} (triggers Vercel Push-to-Deploy if linked)`,
              onClick: onPushOrigin,
            }, `Push GitHub${repoOverview?.ahead ? ` ↑${repoOverview.ahead}` : ''}`)
          : h('button', {
              type: 'button',
              className: 'wk-btn wk-btn-secondary',
              disabled: busy || !repoStatus?.isGit,
              title: 'Create GitHub repo via PAT and push origin',
              onClick: onPublishGithub,
            }, 'Publish GitHub'),
        h('button', { className: 'wk-btn wk-btn-subtle', disabled: busy || !repoStatus?.isGit, onClick: onSync, 'aria-label': 'Sync repository' }, 'Vault Sync'),
        h('button', { className: 'wk-btn wk-btn-subtle', disabled: busy || !repoStatus?.isGit, onClick: () => onInspectDiff('HEAD') }, 'Diff'),
      ]);
    }

    function RepoMeshToolbar({
      workspaceDir,
      repoFolderBasename,
      activePeer,
      peerList,
      channels = [],
      selectedRecipients = [],
      onToggleRecipient = null,
      activeRoomId,
      repoStatus,
      repoDiff,
      customCommitMessage = '',
      setCustomCommitMessage = () => {},
      onCommitAndShare = () => {},
      onCommit = () => {},
      isEmbedded,
      busy,
      onPickFolder,
      onSelectPeer,
      onInspectDiff,
      onBack = null,
      headerActions = null,
    }) {
      const seenTargets = new Set();
      const targetList = [...peerList, ...channels].filter(p => {
        if (!p || p.isNote || !p.peerToken) return false;
        const key = String(p.peerToken).toLowerCase();
        if (seenTargets.has(key)) return false;
        seenTargets.add(key);
        return true;
      });
      const ghPeers = peerList.filter(p => p && !p.isNote && !p.isChannel && p.username);
      const selectedTarget = targetList.find(p => p.peerToken === activePeer?.peerToken) || null;
      const canShare = Boolean(!busy && workspaceDir && activeRoomId && selectedTarget);
      return h('div', { className: 'wk-mesh-tools' }, [
        h('div', { className: 'wk-mesh-row' }, [
          onBack && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-back', onClick: onBack, 'aria-label': 'Back to conversation list' }, h(SvgIcon, { path: 'M15 18l-6-6 6-6', size: 18 })),
          h('button', { className: 'wk-btn wk-btn-secondary', onClick: onPickFolder, title: workspaceDir || 'Choose local Git repository' }, repoFolderBasename || 'Choose repo'),
          h('select', {
            'aria-label': 'Share with collaborator',
            value: activePeer?.isNote ? '' : activePeer?.peerToken || '',
            onChange: e => { const peer = targetList.find(p => p.peerToken === e.target.value); if (peer) onSelectPeer(peer); },
            className: 'wk-input wk-mesh-select',
          }, [
            h('option', { value: '' }, targetList.length ? 'Target (@user / #ch)...' : 'No collaborators'),
            ...targetList.map(peer => h('option', { key: peer.peerToken, value: peer.peerToken }, peer.isChannel ? `#${peer.alias || peer.peerToken}` : `@${peer.username || peer.alias || peer.peerToken}`)),
          ]),
          workspaceDir && h('input', {
            className: 'wk-input',
            'aria-label': 'Commit message',
            placeholder: repoStatus?.totalChanges ? `Commit message (${repoStatus.totalChanges} changes)...` : 'Optional commit message...',
            value: customCommitMessage,
            onChange: e => setCustomCommitMessage(e.target.value),
            onKeyDown: e => { if (e.key === 'Enter' && canShare) onCommitAndShare(); },
            style: { flex: 1, minWidth: 140, minHeight: 32, height: 32, fontSize: 12 },
          }),
          repoStatus?.totalChanges > 0 && h('button', {
            type: 'button',
            className: 'wk-btn wk-btn-secondary',
            disabled: busy || !customCommitMessage.trim(),
            onClick: onCommit,
            title: 'Commit changes locally without sharing',
          }, 'Commit'),
          h('button', {
            className: 'wk-btn wk-btn-primary',
            disabled: !canShare,
            title: canShare ? 'Auto-commit pending changes if any, push Vault branch, and share RepoCard via E2EE Relay' : 'Open a repo and choose a collaborator or channel first',
            onClick: onCommitAndShare,
          }, repoStatus?.totalChanges ? 'Commit & Share' : `Share${activePeer && !activePeer.isNote ? ` ${activePeer.isChannel ? '#' : '@'}${activePeer.username || activePeer.alias}` : ''}`),
        ]),
        headerActions && h('div', { className: 'wk-mesh-row' }, headerActions),
        onToggleRecipient && ghPeers.length >= 2 && h('div', { className: 'wk-mesh-row', style: { gap: 4 } }, [
          h('span', { style: { fontSize: 10, color: 'var(--wk-secondary)' } }, 'Also grant:'),
          ...ghPeers.map(p => {
            const uname = String(p.username).replace(/^@+/, '');
            const active = selectedRecipients.includes(uname);
            return h('button', {
              key: uname,
              type: 'button',
              className: `wk-yt-filter-chip ${active ? 'active' : ''}`,
              'aria-pressed': active,
              onClick: () => onToggleRecipient(uname),
            }, `@${uname}`);
          }),
        ]),
        isEmbedded && workspaceDir && h('code', { className: 'wk-workbench-path', title: workspaceDir }, workspaceDir),
      ]);
    }

    function DiffInspectorDrawer({ drawerDiff, loading = false, onClose }) {
      return h('div', { className: 'wk-drawer' }, [
        h('div', { className: 'wk-drawer-head' }, [
          h('span', { style: { fontWeight: 700, fontSize: 13, color: 'var(--wk-text)' } },
            `Git Diff Inspector${drawerDiff ? ` (+${drawerDiff.totalAdditions || 0} / -${drawerDiff.totalDeletions || 0})` : ''}`),
          h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', 'aria-label': 'Close diff inspector', onClick: onClose }, h(SvgIcon, { path: Icons.Close, size: 13 })),
        ]),
        h('div', { className: 'wk-drawer-body' },
          loading && !drawerDiff?.diffText
            ? 'Loading diff...'
            : !drawerDiff?.diffText
              ? 'Working tree is clean. No uncommitted diff.'
              : h(DiffPreview, { key: drawerDiff.diffText, text: drawerDiff.diffText })
        ),
      ]);
    }

    function MergeConflictModal({ conflicts, onAbort, onComplete, onResolve }) {
      return h('div', {
        style: {
          position: 'fixed', inset: 0, background: 'rgba(7, 11, 20, 0.85)', zIndex: 100010,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
        },
      }, [
        h('div', {
          style: {
            width: '720px', maxHeight: '80vh', background: 'var(--wk-surface)', border: '1px solid var(--wk-border-strong)',
            borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          },
        }, [
          h('div', { style: { padding: '12px 16px', borderBottom: '1px solid var(--wk-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
            h('span', { style: { fontWeight: 700, fontSize: 13 } }, `Resolve Merge Conflicts (${conflicts.length})`),
            h('div', { style: { display: 'flex', gap: 6 } }, [
              h('button', { className: 'wk-btn wk-btn-danger wk-btn-sm', onClick: onAbort }, 'Abort Merge'),
              h('button', { className: 'wk-btn wk-btn-primary wk-btn-sm', onClick: onComplete }, 'Complete Merge'),
            ]),
          ]),
          h('div', { style: { flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
            conflicts.map((c) =>
              h('div', { key: c.file, style: { background: 'var(--wk-canvas)', border: '1px solid var(--wk-subtle)', borderRadius: 6, padding: 12 } }, [
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } }, [
                  h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--wk-text)' } }, c.file),
                  h('div', { style: { display: 'flex', gap: 6 } }, [
                    h('button', { className: 'wk-btn wk-btn-secondary wk-btn-sm', onClick: () => onResolve(c.file, 'ours') }, 'Accept Mine'),
                    h('button', { className: 'wk-btn wk-btn-primary wk-btn-sm', onClick: () => onResolve(c.file, 'theirs') }, 'Accept Theirs'),
                  ]),
                ]),
                h('pre', { style: { margin: 0, maxHeight: 160, overflow: 'auto', fontSize: 10, color: 'var(--wk-secondary)' } }, c.working),
              ])
            )
          ),
        ]),
      ]);
    }
