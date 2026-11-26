    function diffRows(text) {
      let oldLine = 0, newLine = 0;
      return String(text || '').split('\n').map(line => {
        const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { line, kind: 'hunk', old: '', next: '' }; }
        if (/^(diff |index |--- |\+\+\+ |\\)/.test(line)) return { line, kind: 'meta', old: '', next: '' };
        if (line.startsWith('+')) return { line, kind: 'add', old: '', next: newLine++ };
        if (line.startsWith('-')) return { line, kind: 'remove', old: oldLine++, next: '' };
        if (line.startsWith(' ')) return { line, kind: 'context', old: oldLine++, next: newLine++ };
        return { line, kind: 'meta', old: '', next: '' };
      });
    }
    function DiffPreview({ text = '' }) {
      const [expanded, setExpanded] = useState(false);
      const [copyStatus, setCopyStatus] = useState('Copy Diff');
      const lines = String(text).split('\n');
      const rows = diffRows((expanded ? lines : lines.slice(0, 10)).join('\n'));
      return h('div', { className: 'wk-diff-preview' }, [
        h('div', { className: 'wk-diff-tools' }, [h('span', null, `${lines.length} lines`), h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: async () => { try { await navigator.clipboard.writeText(text); setCopyStatus('Copied'); setTimeout(() => setCopyStatus('Copy Diff'), 1800); } catch { setCopyStatus('Copy failed'); } } }, copyStatus)]),
        h('pre', { className: 'wk-inline-diff', 'aria-label': 'Diff preview' }, (expanded ? rows : rows.slice(0, 10)).map((row, i) => h('div', { key: i, className: `wk-diff-line ${row.kind}` }, [h('span', { className: 'wk-diff-number', 'aria-hidden': true }, String(row.old)), h('span', { className: 'wk-diff-number', 'aria-hidden': true }, String(row.next)), h('code', null, row.line || ' ')]))),
        lines.length > 10 && h('button', { type: 'button', className: 'wk-btn wk-btn-subtle', 'aria-expanded': expanded, onClick: () => setExpanded(!expanded) }, expanded ? 'Collapse diff' : `Show all ${lines.length} lines`),
      ]);
    }
    function RepoCard({ message, meta, hasLocal, busy, onClone, onDiff, onMerge, onPush }) {
      const username = meta.peerUsername || meta.senderUsername || message.senderName || 'collaborator';
      const native = meta.branch?.startsWith('collab/') && !!meta.vaultOwner && !!meta.vaultRepo;
      return h('article', { className: 'wk-repo-card', 'aria-label': `${meta.repoName || 'Repository'} card` }, [
        h('div', { className: 'wk-repo-head' }, [h('strong', null, meta.repoName || 'Repository'), h('span', { className: 'wk-repo-badge' }, meta.branch || 'Unknown branch'), meta.commitHash && h('code', { title: meta.commitHash }, meta.commitHash.slice(0, 7))]),
        h('div', { className: 'wk-repo-sender' }, [h('span', { className: 'wk-chat-avatar', 'aria-hidden': true }, username.slice(0, 2).toUpperCase()), h('strong', null, `@${username}`), message.created_at && h('time', { dateTime: message.created_at }, new Date(message.created_at).toLocaleString())]),
        h('p', { className: 'wk-repo-desc' }, message.content),
        (meta.diffPreview || meta.diffSummary) && h(DiffPreview, { text: meta.diffPreview || (typeof meta.diffSummary === 'string' ? meta.diffSummary : `${meta.diffSummary?.files || 0} files · +${meta.diffSummary?.additions || 0} -${meta.diffSummary?.deletions || 0}`) }),
        !native && h('p', { className: 'wk-peer-sub' }, 'Legacy card. Ask the sender to share again through Vault Git.'),
        h('div', { className: 'wk-repo-actions' }, [
          !hasLocal
            ? h('button', { className: 'wk-btn wk-btn-primary', disabled: busy || !native, onClick: () => onClone(meta) }, 'Download & Clone')
            : h('button', { className: 'wk-btn wk-btn-primary', disabled: busy || !native, onClick: () => onMerge(meta) }, 'Pull & Merge'),
          h('button', { className: 'wk-btn wk-btn-secondary', disabled: busy || !hasLocal || !native, onClick: () => onDiff(meta) }, 'Inspect Diff'),
        ]),
      ]);
    }
