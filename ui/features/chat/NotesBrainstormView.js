    // --- Notes Brainstorm View (Tree Mind Map, Mermaid Live SVG, Whiteboard, Outline) ---
    function parseMermaidDiagram(rawCode = '') {
      const lines = String(rawCode || '').split(/\r?\n/).map(l => l.replace(/\t/g, '  ')).filter(l => l.trim() && !l.trim().startsWith('%%'));
      if (!lines.length) return { kind: 'empty', nodes: [], edges: [] };
      const head = lines[0].trim().toLowerCase();
      if (head.startsWith('mindmap')) {
        const items = [];
        for (let i = 1; i < lines.length; i++) {
          const indent = lines[i].search(/\S/);
          const label = lines[i].trim().replace(/^root\(\((.+?)\)\)$/, '$1').replace(/^[\(\[\{]+|[\)\]\}]+$/g, '').trim();
          if (label) items.push({ indent, label, idx: i });
        }
        if (!items.length) return { kind: 'empty', nodes: [], edges: [] };
        const root = { id: 'mm-0', label: items[0].label, children: [] };
        const stack = [{ indent: items[0].indent, node: root }];
        items.slice(1).forEach((item, i) => {
          const node = { id: `mm-${i + 1}`, label: item.label, children: [] };
          while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) stack.pop();
          stack[stack.length - 1].node.children.push(node);
          stack.push({ indent: item.indent, node });
        });
        return { kind: 'mindmap', root };
      }

      const horizontal = /\b(?:LR|RL)\b/i.test(head);
      const nodeMap = new Map();
      const edges = [];
      const cleanNode = token => {
        const t = token.trim();
        const m = t.match(/^([A-Za-z0-9_-]+)\s*(?:\(\((.+?)\)\)|\[(.+?)\]|\{(.+?)\}|\((.+?)\))?$/);
        if (!m) return null;
        const id = m[1];
        const shape = t.includes('{') ? 'diamond' : t.includes('((') ? 'circle' : t.includes('(') ? 'round' : 'rect';
        const label = (m[2] || m[3] || m[4] || m[5] || id).trim();
        if (!nodeMap.has(id)) nodeMap.set(id, { id, label, shape });
        else if (label !== id) nodeMap.set(id, { id, label, shape });
        return id;
      };
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^(?:subgraph|end|style|classDef|class|click)\b/i.test(line)) continue;
        const arrow = line.match(/^(.+?)\s*(?:-->|-.->|==>)\s*(?:\|([^|]+)\|\s*)?(.+)$/);
        if (arrow) {
          const from = cleanNode(arrow[1]);
          const to = cleanNode(arrow[3]);
          if (from && to) edges.push({ from, to, label: (arrow[2] || '').trim(), dashed: line.includes('-.->') });
        } else {
          cleanNode(line);
        }
      }
      const nodes = [...nodeMap.values()];
      if (!nodes.length) return { kind: 'empty', nodes: [], edges: [] };
      const depth = new Map(nodes.map(n => [n.id, 0]));
      for (let pass = 0; pass < nodes.length; pass++) {
        for (const e of edges) {
          const next = (depth.get(e.from) || 0) + 1;
          if (next > (depth.get(e.to) || 0) && next <= nodes.length) depth.set(e.to, next);
        }
      }
      const layers = new Map();
      nodes.forEach(n => {
        const d = depth.get(n.id) || 0;
        if (!layers.has(d)) layers.set(d, []);
        layers.get(d).push(n);
      });
      const positioned = [];
      const posById = new Map();
      [...layers.keys()].sort((a, b) => a - b).forEach((d, colIdx) => {
        const bucket = layers.get(d);
        bucket.forEach((n, rowIdx) => {
          const x = horizontal ? 40 + colIdx * 185 : 50 + rowIdx * 175;
          const y = horizontal ? 45 + rowIdx * 82 : 36 + colIdx * 96;
          const item = { ...n, x, y, w: 136, h: 42 };
          positioned.push(item);
          posById.set(n.id, item);
        });
      });
      return { kind: 'flow', nodes: positioned, posById, edges };
    }

    function MermaidSvgPreview({ code, zoom = 1 }) {
      const parsed = useMemo(() => parseMermaidDiagram(code), [code]);
      if (parsed.kind === 'empty') {
        return h('pre', { style: { fontFamily: 'ui-monospace, monospace', fontSize: 12, color: 'var(--wk-secondary)', padding: 16 } }, 'Write mindmap or graph TD / flowchart LR syntax to render live SVG.');
      }
      if (parsed.kind === 'mindmap') {
        const leaves = [];
        let cursorY = 48;
        const place = (node, depth, parent) => {
          const x = 40 + depth * 175;
          const startY = cursorY;
          if (!node.children.length) {
            const y = cursorY;
            cursorY += 54;
            leaves.push({ node, x, y, depth, parent });
            return y;
          }
          const ys = node.children.map(ch => place(ch, depth + 1, node));
          const y = (ys[0] + ys[ys.length - 1]) / 2;
          leaves.push({ node, x, y, depth, parent });
          return y;
        };
        place(parsed.root, 0, null);
        const byNode = new Map(leaves.map(l => [l.node, l]));
        const maxW = Math.max(540, ...leaves.map(l => l.x + 170));
        const maxH = Math.max(260, cursorY + 24);
        return h('svg', {
          viewBox: `0 0 ${maxW} ${maxH}`,
          style: { width: '100%', height: '100%', minHeight: 240, transform: `scale(${zoom})`, transformOrigin: 'top left', transition: 'transform 150ms ease' },
          'aria-label': 'Mermaid mindmap diagram',
        }, [
          ...leaves.filter(l => l.parent).map((l, i) => {
            const p = byNode.get(l.parent);
            const sx = p.x + 132, sy = p.y + 17, tx = l.x, ty = l.y + 17, cx = (sx + tx) / 2;
            return h('path', { key: `e-${i}`, d: `M ${sx} ${sy} C ${cx} ${sy}, ${cx} ${ty}, ${tx} ${ty}`, fill: 'none', stroke: 'rgba(56, 189, 248, 0.5)', strokeWidth: 2 });
          }),
          ...leaves.map((l, i) => h('g', { key: l.node.id || i, transform: `translate(${l.x}, ${l.y})` }, [
            h('rect', { width: 132, height: 34, rx: l.depth === 0 ? 17 : 7, fill: l.depth === 0 ? 'rgba(16, 185, 129, 0.14)' : 'var(--wk-surface, #12151b)', stroke: l.depth === 0 ? '#10b981' : 'var(--wk-border-strong, rgba(255,255,255,0.18))', strokeWidth: l.depth === 0 ? 1.8 : 1.2 }),
            h('text', { x: 66, y: 21, textAnchor: 'middle', fill: 'var(--wk-text, #e6edf3)', fontSize: 11, fontWeight: l.depth === 0 ? 700 : 500 }, l.node.label.slice(0, 18)),
          ])),
        ]);
      }
      const maxW = Math.max(460, ...parsed.nodes.map(n => n.x + n.w + 40));
      const maxH = Math.max(260, ...parsed.nodes.map(n => n.y + n.h + 40));
      return h('svg', {
        viewBox: `0 0 ${maxW} ${maxH}`,
        style: { width: '100%', height: '100%', minHeight: 240, transform: `scale(${zoom})`, transformOrigin: 'top left', transition: 'transform 150ms ease' },
        'aria-label': 'Mermaid flowchart diagram',
      }, [
        h('defs', { key: 'defs' }, h('marker', { id: 'wk-mermaid-arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, h('path', { d: 'M 0 1 L 10 5 L 0 9 z', fill: '#38bdf8' }))),
        ...parsed.edges.map((e, idx) => {
          const from = parsed.posById.get(e.from);
          const to = parsed.posById.get(e.to);
          if (!from || !to) return null;
          const sx = from.x + from.w / 2, sy = from.y + from.h;
          const tx = to.x + to.w / 2, ty = to.y;
          const mx = (sx + tx) / 2, my = (sy + ty) / 2;
          return h('g', { key: `edge-${idx}` }, [
            h('path', { d: `M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty - 3}`, fill: 'none', stroke: 'rgba(56, 189, 248, 0.7)', strokeWidth: 1.8, strokeDasharray: e.dashed ? '4 3' : undefined, markerEnd: 'url(#wk-mermaid-arrow)' }),
            e.label && h('text', { x: mx, y: my - 4, textAnchor: 'middle', fill: '#34d399', fontSize: 10, fontWeight: 600 }, e.label.slice(0, 16)),
          ]);
        }),
        ...parsed.nodes.map(n => {
          if (n.shape === 'diamond') {
            const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
            const pts = `${cx},${n.y - 4} ${n.x + n.w + 4},${cy} ${cx},${n.y + n.h + 4} ${n.x - 4},${cy}`;
            return h('g', { key: n.id }, [
              h('polygon', { points: pts, fill: 'var(--wk-elevated, #181c24)', stroke: '#38bdf8', strokeWidth: 1.5 }),
              h('text', { x: cx, y: cy + 4, textAnchor: 'middle', fill: 'var(--wk-text, #e6edf3)', fontSize: 11, fontWeight: 600 }, n.label.slice(0, 16)),
            ]);
          }
          return h('g', { key: n.id, transform: `translate(${n.x}, ${n.y})` }, [
            h('rect', { width: n.w, height: n.h, rx: n.shape === 'circle' ? 21 : n.shape === 'round' ? 12 : 6, fill: 'var(--wk-surface, #12151b)', stroke: 'var(--wk-border-strong, rgba(255,255,255,0.22))', strokeWidth: 1.4 }),
            h('text', { x: n.w / 2, y: 25, textAnchor: 'middle', fill: 'var(--wk-text, #e6edf3)', fontSize: 11, fontWeight: 600 }, n.label.slice(0, 18)),
          ]);
        }),
      ]);
    }

    function NotesBrainstormView({
      note,
      onUpdateNote,
      onExportMarkdown,
      attachedFiles = [],
      onAttachFiles,
      onRemoveAttachedFile,
      fileInputRef,
    }) {
      const initialDoc = target => target?.docText ?? ((target?.messages || []).map(m => m.content).join('\n\n') || `# ${target?.title || 'Note'}\n- Idea 1\n- Idea 2\n## Deep Dive\n- Detail A\n- Detail B`);
      const defaultMermaid = 'mindmap\n  root((Brainstorm))\n    Architecture\n      Core Engine\n      Client Plugin\n    Features\n      Saul Music\n      Git Collab\n      Intel Reader';
      const defaultCards = [
        { id: 'c1', x: 40, y: 40, title: 'Architecture', text: 'Decentralized P2P workspace with Discord rail', color: '#1e293b' },
        { id: 'c2', x: 260, y: 120, title: 'Saul Audio', text: 'Brave 144p zero-RAM background player', color: '#0f766e' },
        { id: 'c3', x: 480, y: 60, title: 'Intel Reader', text: 'Zero-auth public social & research feed', color: '#312e81' },
      ];
      const normalizeMode = m => (m === 'mindmap' || m === 'mermaid' || m === 'diagram') ? 'diagram' : (m === 'whiteboard' ? 'whiteboard' : 'doc');
      const [viewMode, setViewMode] = useState(() => normalizeMode(note?.noteMode));
      const [diagramKind, setDiagramKind] = useState(() => note?.noteMode === 'mermaid' ? 'mermaid' : 'auto');
      const [docText, setDocText] = useState(() => initialDoc(note));
      const [mermaidCode, setMermaidCode] = useState(() => note?.mermaidCode || defaultMermaid);
      const [cards, setCards] = useState(() => note?.whiteboardCards || defaultCards);
      const [zoom, setZoom] = useState(1);
      const loadedIdRef = useRef(note?.id);
      const loadedAppendRef = useRef(note?.externalAppendAt || 0);

      useEffect(() => {
        if (!note) return;
        const switchedNote = loadedIdRef.current !== note.id;
        const appended = (note.externalAppendAt || 0) !== loadedAppendRef.current;
        if (switchedNote || appended) {
          loadedIdRef.current = note.id;
          loadedAppendRef.current = note.externalAppendAt || 0;
          setViewMode(normalizeMode(note.noteMode));
          if (note.noteMode === 'mermaid') setDiagramKind('mermaid');
          else if (note.noteMode === 'mindmap') setDiagramKind('auto');
          setDocText(initialDoc(note));
          setMermaidCode(note.mermaidCode || defaultMermaid);
          setCards(note.whiteboardCards || defaultCards);
        }
      }, [note?.id, note?.externalAppendAt]);

      useEffect(() => {
        if (!note || loadedIdRef.current !== note.id) return;
        onUpdateNote({
          ...note,
          noteMode: viewMode,
          docText,
          mermaidCode,
          whiteboardCards: cards,
          updatedAt: Date.now(),
        });
      }, [viewMode, docText, mermaidCode, cards]);

      const parsedTree = useMemo(() => {
        const lines = (docText || '').split('\n');
        const root = { id: 'root', label: note?.title || 'Root', children: [] };
        let currentH1 = null;
        let currentH2 = null;

        lines.forEach((line, idx) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (trimmed.startsWith('# ')) {
            const item = { id: `h1-${idx}`, label: trimmed.replace(/^#\s*/, ''), children: [] };
            root.children.push(item);
            currentH1 = item;
            currentH2 = null;
          } else if (trimmed.startsWith('## ')) {
            const item = { id: `h2-${idx}`, label: trimmed.replace(/^##\s*/, ''), children: [] };
            if (currentH1) currentH1.children.push(item);
            else root.children.push(item);
            currentH2 = item;
          } else if (trimmed.startsWith('### ') || trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
            const item = { id: `item-${idx}`, label: trimmed.replace(/^(?:###|-|\*)\s*/, ''), children: [] };
            if (currentH2) currentH2.children.push(item);
            else if (currentH1) currentH1.children.push(item);
            else root.children.push(item);
          }
        });

        if (!root.children.length && docText.trim()) {
          docText.split('\n').filter(Boolean).slice(0, 10).forEach((t, i) => {
            root.children.push({ id: `i-${i}`, label: t.slice(0, 40), children: [] });
          });
        }
        return root;
      }, [docText, note?.title]);

      const activeCardDrag = useRef(null);
      const onCardPointerDown = (cardId, e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const card = cards.find(c => c.id === cardId);
        if (!card) return;
        activeCardDrag.current = { id: cardId, startX: e.clientX, startY: e.clientY, cardX: card.x, cardY: card.y, elem: e.currentTarget, pid: e.pointerId };
      };
      const onCardPointerMove = (e) => {
        const d = activeCardDrag.current;
        if (!d || d.pid !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        setCards(prev => prev.map(c => c.id === d.id ? { ...c, x: Math.max(10, d.cardX + dx), y: Math.max(10, d.cardY + dy) } : c));
      };
      const onCardPointerUp = (e) => {
        const d = activeCardDrag.current;
        if (!d || d.pid !== e.pointerId) return;
        if (d.elem?.hasPointerCapture(d.pid)) d.elem.releasePointerCapture(d.pid);
        activeCardDrag.current = null;
      };

      const handleAddCard = () => {
        const id = 'c-' + Date.now();
        const newCard = { id, x: 80 + Math.random() * 200, y: 80 + Math.random() * 200, title: 'New Idea', text: 'Detail thought...', color: '#181c24' };
        setCards(prev => [...prev, newCard]);
      };

      return h('div', { className: 'wk-notes-brainstorm-wrap' }, [
        h('div', { className: 'wk-notes-mode-bar' }, [
          h('div', { className: 'wk-notes-mode-pills' }, [
            h('button', { type: 'button', className: `wk-notes-mode-pill ${viewMode === 'doc' ? 'active' : ''}`, onClick: () => setViewMode('doc') }, [h(SvgIcon, { path: Icons.Edit, size: 12 }), ' Doc']),
            h('button', { type: 'button', className: `wk-notes-mode-pill ${viewMode === 'diagram' ? 'active' : ''}`, onClick: () => setViewMode('diagram') }, [h(SvgIcon, { path: Icons.Diagram, size: 12 }), ' Mindmap & Diagram']),
            h('button', { type: 'button', className: `wk-notes-mode-pill ${viewMode === 'whiteboard' ? 'active' : ''}`, onClick: () => setViewMode('whiteboard') }, [h(SvgIcon, { path: Icons.Canvas, size: 12 }), ' Whiteboard']),
          ]),
          h('div', { style: { display: 'flex', gap: 6 } }, [
            h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: onExportMarkdown, title: 'Export note to Markdown file' }, 'Export .md'),
            h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => fileInputRef.current && fileInputRef.current.click(), title: 'Attach files' }, h(SvgIcon, { path: Icons.Attach, size: 14 })),
          ]),
        ]),

        viewMode === 'doc' && h('div', { className: 'wk-notes-editor-pane' }, [
          attachedFiles.length > 0 && h('div', { className: 'wk-attached-pills' },
            attachedFiles.map((f, idx) => h('span', { key: idx, className: 'wk-file-pill' }, [
              h(SvgIcon, { path: Icons.Attach, size: 12 }),
              h('span', { className: 'wk-file-pill-name' }, f.name),
              h('button', { type: 'button', className: 'wk-pill-remove', onClick: () => onRemoveAttachedFile(idx) }, '×'),
            ]))
          ),
          h('textarea', {
            className: 'wk-notes-textarea',
            value: docText,
            onChange: e => setDocText(e.target.value),
            placeholder: '# Note Title\n- Outline idea 1\n- Outline idea 2\n## Subtopic\n- Detail point\n\nWrite freely or brainstorm here. Switches automatically to Mind Map Tree, Mermaid, and Whiteboard.',
          }),
        ]),

        viewMode === 'diagram' && h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } }, [
          h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: '1px solid var(--wk-subtle)', background: 'var(--wk-surface)' } }, [
            h('div', { style: { display: 'flex', gap: 6 } }, [
              h('button', { type: 'button', className: `wk-notes-mode-pill ${diagramKind === 'auto' ? 'active' : ''}`, onClick: () => setDiagramKind('auto') }, 'Auto Mindmap'),
              h('button', { type: 'button', className: `wk-notes-mode-pill ${diagramKind === 'mermaid' ? 'active' : ''}`, onClick: () => setDiagramKind('mermaid') }, 'Mermaid Diagram'),
            ]),
            h('div', { style: { display: 'flex', gap: 4 } }, [
              h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setZoom(z => Math.min(2, z + 0.15)) }, '+'),
              h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setZoom(z => Math.max(0.5, z - 0.15)) }, '-'),
              h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setZoom(1) }, 'Reset'),
            ]),
          ]),
          diagramKind === 'auto' ? h('div', { className: 'wk-mindmap-canvas' }, [
            h('svg', {
              width: '100%',
              height: '100%',
              style: { flex: 1, minHeight: 0, transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 150ms ease' },
            }, [
              h('g', { key: 'root-node', transform: 'translate(60, 200)' }, [
                h('rect', { width: 140, height: 42, rx: 8, fill: 'var(--wk-surface, #12151b)', stroke: '#38bdf8', strokeWidth: 2 }),
                h('text', { x: 70, y: 26, textAnchor: 'middle', fill: 'var(--wk-text, #e6edf3)', fontSize: 13, fontWeight: 700 }, (parsedTree.label || 'Note').slice(0, 16)),
              ]),
              ...parsedTree.children.map((child, i) => {
                const startX = 200;
                const startY = 221;
                const targetX = 320;
                const targetY = 70 + i * 65;
                const cX = (startX + targetX) / 2;
                return h('g', { key: child.id }, [
                  h('path', {
                    d: `M ${startX} ${startY} C ${cX} ${startY}, ${cX} ${targetY}, ${targetX} ${targetY}`,
                    fill: 'none',
                    stroke: 'rgba(56, 189, 248, 0.45)',
                    strokeWidth: 2,
                  }),
                  h('g', { transform: `translate(${targetX}, ${targetY - 18})` }, [
                    h('rect', { width: 150, height: 36, rx: 6, fill: 'var(--wk-elevated, #181c24)', stroke: 'var(--wk-border-strong, rgba(255,255,255,0.15))', strokeWidth: 1 }),
                    h('text', { x: 75, y: 22, textAnchor: 'middle', fill: 'var(--wk-text, #e6edf3)', fontSize: 12, fontWeight: 600 }, child.label.slice(0, 18)),
                  ]),
                  ...child.children.map((sub, j) => {
                    const sStartX = targetX + 150;
                    const sStartY = targetY;
                    const sTargetX = 530;
                    const sTargetY = targetY - 20 + j * 32;
                    const sCX = (sStartX + sTargetX) / 2;
                    return h('g', { key: sub.id }, [
                      h('path', {
                        d: `M ${sStartX} ${sStartY} C ${sCX} ${sStartY}, ${sCX} ${sTargetY}, ${sTargetX} ${sTargetY}`,
                        fill: 'none',
                        stroke: 'rgba(255, 255, 255, 0.2)',
                        strokeWidth: 1.5,
                        strokeDasharray: '4 2',
                      }),
                      h('g', { transform: `translate(${sTargetX}, ${sTargetY - 14})` }, [
                        h('rect', { width: 130, height: 28, rx: 4, fill: 'var(--wk-subtle, #202531)', stroke: 'var(--wk-border, rgba(255,255,255,0.08))', strokeWidth: 1 }),
                        h('text', { x: 65, y: 18, textAnchor: 'middle', fill: 'var(--wk-secondary, #8b949e)', fontSize: 11 }, sub.label.slice(0, 16)),
                      ]),
                    ]);
                  }),
                ]);
              }),
            ]),
          ]) : h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } }, [
            h('div', { style: { width: '42%', borderRight: '1px solid var(--wk-subtle)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } }, [
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
                h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setMermaidCode('mindmap\n  root((Brainstorm))\n    Architecture\n      Core Engine\n      Client Plugin\n    Features\n      Saul Music\n      Git Collab') }, '+ Mindmap'),
                h('button', { type: 'button', className: 'wk-btn wk-btn-subtle wk-btn-sm', onClick: () => setMermaidCode('graph TD\n  A[Start Idea] --> B{Feasible?}\n  B -->|Yes| C[Implement Slice]\n  B -->|No| D[Refine Scope]') }, '+ Flowchart'),
              ]),
              h('textarea', {
                className: 'wk-notes-textarea',
                value: mermaidCode,
                onChange: e => setMermaidCode(e.target.value),
                style: { flex: 1, minHeight: 0 },
              }),
            ]),
            h('div', { style: { flex: 1, padding: 16, overflow: 'auto', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--wk-canvas)' } }, [
              h(MermaidSvgPreview, { code: mermaidCode, zoom }),
            ]),
          ]),
        ]),

        viewMode === 'whiteboard' && h('div', {
          className: 'wk-whiteboard-canvas',
          onPointerMove: onCardPointerMove,
          onPointerUp: onCardPointerUp,
          onPointerCancel: onCardPointerUp,
        }, [
          h('div', { style: { position: 'absolute', top: 12, right: 12, zIndex: 20 } }, [
            h('button', { type: 'button', className: 'wk-btn wk-btn-primary wk-btn-sm', onClick: handleAddCard }, '+ Add Sticky Card'),
          ]),
          ...cards.map(c => h('div', {
            key: c.id,
            className: 'wk-whiteboard-card',
            style: { left: c.x, top: c.y, background: c.color || 'var(--wk-surface)' },
            onPointerDown: e => onCardPointerDown(c.id, e),
          }, [
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [
              h('input', {
                value: c.title,
                onChange: e => setCards(prev => prev.map(item => item.id === c.id ? { ...item, title: e.target.value } : item)),
                style: { background: 'transparent', border: 0, color: 'var(--wk-text)', fontWeight: 700, fontSize: 13, outline: 'none', width: '80%' },
              }),
              h('button', {
                type: 'button',
                style: { background: 'transparent', border: 0, color: 'var(--wk-secondary)', cursor: 'pointer', fontSize: 14 },
                onClick: e => { e.stopPropagation(); setCards(prev => prev.filter(item => item.id !== c.id)); },
              }, '×'),
            ]),
            h('textarea', {
              value: c.text,
              onChange: e => setCards(prev => prev.map(item => item.id === c.id ? { ...item, text: e.target.value } : item)),
              rows: 3,
              style: { background: 'transparent', border: 0, color: 'var(--wk-secondary)', fontSize: 11, resize: 'none', outline: 'none', width: '100%', fontFamily: 'inherit' },
            }),
          ])),
        ]),
      ]);
    }
