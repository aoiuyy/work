    function SettingsPanel({
      auth,
      patInput = '',
      setPatInput = () => {},
      patBusy = false,
      deviceAuth = null,
      onStartDeviceLogin = () => {},
      onCancelDeviceLogin = () => {},
      pendingInvites = [],
      onAcceptInvite = () => {},
      workConfig = {},
      setWorkConfig = () => {},
      configDirty = false,
      onPickDefaultParent = () => {},
      onSaveConfig = () => {},
      showBubble = true,
      onToggleBubble = null,
      busy = false,
      realtimeStatus = null,
      updateInfo = { status: 'idle' },
      isHost = false,
      publishingUpdate = false,
      restartingUpdate = false,
      onPublishUpdate = () => {},
      onRestartToUpdate = () => {},
      onCheckUpdate = null,
      onClose,
      onConnectGithub,
      onDisconnectGithub,
    }) {
      const [confirmDisconnect, setConfirmDisconnect] = typeof useState === 'function' ? useState(false) : [false, () => {}];
      const [showPatFallback, setShowPatFallback] = typeof useState === 'function' ? useState(false) : [false, () => {}];
      const [copiedCode, setCopiedCode] = typeof useState === 'function' ? useState(false) : [false, () => {}];

      const headStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
      const sectionTitleStyle = { fontWeight: 650, fontSize: 12, color: 'var(--wk-text)', letterSpacing: '0.01em' };
      const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 10 };
      const dividerStyle = { borderTop: '1px solid var(--wk-subtle)', paddingTop: 14 };
      const githubLogin = auth?.user?.login || auth?.username;
      const showRestartToUpdate = updateInfo?.status === 'available' || updateInfo?.status === 'installed';
      const manualRestartOnly = updateInfo?.status === 'installed' && Boolean(updateInfo?.manualRestartRequired);
      const copyDeviceCode = () => {
        if (!deviceAuth?.userCode || typeof navigator === 'undefined') return;
        navigator.clipboard?.writeText?.(deviceAuth.userCode).then(() => {
          setCopiedCode(true);
          setTimeout(() => setCopiedCode(false), 1800);
        }).catch(() => {});
      };

      return h('section', { id: 'wk-settings', className: 'wk-settings-panel', 'aria-label': 'Work settings' }, [
        h('div', { className: 'wk-settings-heading wk-settings-topbar' }, [
          showRestartToUpdate && h('button', {
            type: 'button',
            className: `wk-btn ${manualRestartOnly ? 'wk-btn-secondary' : 'wk-btn-primary'} wk-btn-sm`,
            disabled: busy || restartingUpdate || manualRestartOnly,
            onClick: onRestartToUpdate,
          }, restartingUpdate ? 'Updating...' : (manualRestartOnly ? 'Updated — Restart DSH manually' : 'Restart to Update')),
          isHost && h('button', {
            type: 'button',
            className: 'wk-btn wk-btn-secondary wk-btn-sm',
            disabled: busy || publishingUpdate,
            onClick: onPublishUpdate,
          }, publishingUpdate ? 'Releasing...' : 'Release'),
          h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', onClick: onClose, 'aria-label': 'Close settings' }, h(SvgIcon, { path: Icons.Close, size: 18 })),
        ]),

        h('div', { className: 'wk-settings-single wk-update-card' }, [
          // 1. Account
          h('div', { style: sectionStyle }, [
            h('div', { style: headStyle }, [
              h('span', { style: sectionTitleStyle }, 'Account'),
            ]),
            auth?.connected ? h('div', { style: headStyle }, [
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 } }, [
                h('span', { style: { fontWeight: 600, fontSize: 12, color: 'var(--wk-text)' } }, `@${githubLogin || 'User'}`),
                h('span', { style: { fontFamily: 'monospace', fontSize: 11, color: 'var(--wk-secondary)' } }, auth.maskedToken || '••••••••'),
              ]),
              !confirmDisconnect
                ? h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: patBusy, onClick: () => setConfirmDisconnect(true) }, 'Disconnect')
                : h('div', { style: { display: 'flex', gap: 6 } }, [
                    h('button', { type: 'button', className: 'wk-btn wk-btn-danger wk-btn-sm', disabled: patBusy, onClick: () => { setConfirmDisconnect(false); onDisconnectGithub(); } }, patBusy ? 'Disconnecting...' : 'Confirm'),
                    h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', disabled: patBusy, onClick: () => setConfirmDisconnect(false) }, 'Cancel'),
                  ]),
            ]) : h(React.Fragment, null, [
              !deviceAuth?.userCode ? h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } }, [
                h('button', {
                  type: 'button',
                  className: 'wk-btn wk-btn-primary',
                  disabled: patBusy,
                  onClick: onStartDeviceLogin,
                }, [h(SvgIcon, { path: Icons.Github, size: 15 }), patBusy ? 'Authorizing...' : 'Sign in with GitHub']),
                h('button', {
                  type: 'button',
                  className: 'wk-btn wk-btn-subtle wk-btn-sm',
                  onClick: () => setShowPatFallback(v => !v),
                }, showPatFallback ? 'Hide token' : 'Use token (PAT)'),
              ]) : h('div', { className: 'wk-device-box' }, [
                h('div', { style: headStyle }, [
                  h('span', { style: { fontSize: 11, fontWeight: 600, color: 'var(--wk-text)' } }, 'Paste this code on GitHub (copied automatically):'),
                  h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: onCancelDeviceLogin }, 'Cancel'),
                ]),
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
                  h('code', { style: { padding: '5px 10px', borderRadius: 6, background: 'var(--wk-canvas)', border: '1px solid var(--wk-border-strong)', fontSize: 14, fontWeight: 700, letterSpacing: '0.1em' } }, deviceAuth.userCode),
                  h('button', { type: 'button', className: 'wk-btn wk-btn-secondary wk-btn-sm', onClick: copyDeviceCode }, copiedCode ? 'Copied' : 'Copy code'),
                  (deviceAuth.verificationUriComplete || deviceAuth.verificationUri) && h('a', { href: deviceAuth.verificationUriComplete || deviceAuth.verificationUri, target: '_blank', rel: 'noopener noreferrer', className: 'wk-btn wk-btn-primary wk-btn-sm' }, 'Open GitHub'),
                ]),
              ]),
              showPatFallback && !deviceAuth?.userCode && h('div', { className: 'wk-search-row' }, [
                h('input', {
                  type: 'password',
                  className: 'wk-input',
                  placeholder: 'GitHub PAT (ghp_...)',
                  value: patInput,
                  onChange: e => setPatInput(e.target.value),
                  onKeyDown: e => e.key === 'Enter' && onConnectGithub(),
                }),
                h('button', { type: 'button', className: 'wk-btn wk-btn-primary', disabled: patBusy || !(patInput || '').trim(), onClick: onConnectGithub }, patBusy ? 'Connecting...' : 'Connect'),
              ]),
            ]),
            pendingInvites.length > 0 && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4 } }, [
              h('span', { style: { fontSize: 11, fontWeight: 600, color: '#34d399' } }, `Vault Invitations (${pendingInvites.length})`),
              ...pendingInvites.map(inv => h('div', { key: inv.id, className: 'wk-management-repo' }, [
                h('span', { style: { fontSize: 11 } }, inv.repoFullName || `Invite #${inv.id}`),
                h('button', { type: 'button', className: 'wk-btn wk-btn-primary wk-btn-sm', disabled: busy, onClick: () => onAcceptInvite(inv) }, 'Accept'),
              ])),
            ]),
          ]),

          // 2. Workspace
          h('div', { style: { ...sectionStyle, ...dividerStyle } }, [
            h('div', { style: headStyle }, [
              h('span', { style: sectionTitleStyle }, 'Workspace'),
              h('button', { type: 'button', className: `wk-btn wk-btn-sm ${configDirty ? 'wk-btn-primary' : 'wk-btn-secondary'}`, disabled: busy || !configDirty, onClick: onSaveConfig }, configDirty ? 'Save Changes' : 'Save'),
            ]),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
              h('label', { className: 'wk-field-label', htmlFor: 'wk-default-parent', style: { marginTop: 0 } }, 'Default clone folder'),
              h('div', { className: 'wk-search-row' }, [
                h('input', {
                  id: 'wk-default-parent',
                  className: 'wk-input',
                  placeholder: 'Choose default clone directory...',
                  value: workConfig.defaultParent || '',
                  onChange: e => setWorkConfig({ ...workConfig, defaultParent: e.target.value }),
                }),
                h('button', { type: 'button', className: 'wk-btn wk-btn-secondary', onClick: onPickDefaultParent }, 'Browse'),
              ]),
            ]),
            h('div', { className: 'wk-settings-fields-grid' }, [
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('label', { className: 'wk-field-label', htmlFor: 'wk-machine-name', style: { marginTop: 0 } }, 'Machine'),
                h('input', {
                  id: 'wk-machine-name',
                  className: 'wk-input',
                  placeholder: 'Workstation',
                  value: workConfig.machineName || '',
                  onChange: e => setWorkConfig({ ...workConfig, machineName: e.target.value }),
                }),
              ]),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
                h('label', { className: 'wk-field-label', htmlFor: 'wk-vault-repo', style: { marginTop: 0 } }, 'Vault repo'),
                h('input', {
                  id: 'wk-vault-repo',
                  className: 'wk-input',
                  placeholder: 'dsh-work-vault',
                  value: workConfig.vaultRepo || '',
                  onChange: e => setWorkConfig({ ...workConfig, vaultRepo: e.target.value }),
                }),
              ]),
            ]),
            onToggleBubble && h('div', { className: 'wk-toggle-row' }, [
              h('label', { htmlFor: 'wk-toggle-bubble', style: { fontSize: 12, color: 'var(--wk-text)', cursor: 'pointer' } }, 'Floating Bubble'),
              h('button', {
                id: 'wk-toggle-bubble',
                type: 'button',
                role: 'switch',
                className: 'wk-toggle-switch',
                'aria-checked': showBubble ? 'true' : 'false',
                'aria-label': 'Toggle floating Bubble',
                onClick: () => onToggleBubble(!showBubble),
              }, h('span', { className: 'wk-toggle-knob', 'aria-hidden': true })),
            ]),
          ]),

          // Minimal status & version strip
          h('div', { style: { ...headStyle, ...dividerStyle, paddingTop: 10, fontSize: 11, color: 'var(--wk-secondary)' } }, [
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
              h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, `Work v${updateInfo?.currentVersion || '2.0.1'}`),
              h('span', { className: `wk-status-dot ${realtimeStatus?.connected ? 'online' : 'offline'}`, 'aria-hidden': true }),
              h('span', null, realtimeStatus?.connected ? 'Relay online' : 'Relay offline'),
            ]),
            onCheckUpdate && h('button', {
              type: 'button',
              className: 'wk-btn wk-btn-subtle wk-btn-sm',
              disabled: busy,
              onClick: onCheckUpdate,
            }, updateInfo?.status === 'checking' ? 'Checking...' : 'Check update'),
          ]),
        ]),
      ]);
    }