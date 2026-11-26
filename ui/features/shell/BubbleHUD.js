function useResizableWindow() {
  const [frame, setFrame] = useState(() => loadWorkWindowState({ width: window.innerWidth, height: window.innerHeight }));
  const frameRef = useRef(frame);
  const restoreRef = useRef(null);
  const interaction = useRef(null);
  const pendingFrame = useRef(null);
  const raf = useRef(0);

  const scheduleFrame = next => {
    frameRef.current = next;
    pendingFrame.current = next;
    if (raf.current) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      const value = pendingFrame.current;
      pendingFrame.current = null;
      setFrame(value);
      saveWorkWindowState(value);
    });
  };

  const applyPreset = mode => {
    if (mode === 'maximized') {
      if (frameRef.current.mode !== 'maximized') restoreRef.current = frameRef.current;
    } else if (frameRef.current.mode === 'maximized') {
      restoreRef.current = null;
    }
    scheduleFrame(presetWorkWindow(mode, frameRef.current, { width: window.innerWidth, height: window.innerHeight }));
  };

  const toggleMaximize = () => {
    if (frameRef.current.mode === 'maximized') {
      const restored = restoreRef.current || presetWorkWindow('studio', frameRef.current, { width: window.innerWidth, height: window.innerHeight });
      restoreRef.current = null;
      scheduleFrame(clampWorkWindow(restored, { width: window.innerWidth, height: window.innerHeight }));
    } else {
      restoreRef.current = frameRef.current;
      scheduleFrame(presetWorkWindow('maximized', frameRef.current, { width: window.innerWidth, height: window.innerHeight }));
    }
  };

  const beginPointer = (edge, event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget;
    interaction.current = { edge, id: event.pointerId, x: event.clientX, y: event.clientY, frame: frameRef.current, element };
    element.setPointerCapture(event.pointerId);
  };

  const movePointer = event => {
    const active = interaction.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const next = active.edge === 'move'
      ? clampWorkWindow({ ...active.frame, x: active.frame.x + dx, y: active.frame.y + dy, mode: 'custom' }, viewport)
      : resizeWorkWindow(active.frame, active.edge, dx, dy, viewport);
    scheduleFrame(next);
  };

  const endPointer = event => {
    const active = interaction.current;
    if (!active || (event?.pointerId !== undefined && active.id !== event.pointerId)) return;
    interaction.current = null;
    if (active.element.hasPointerCapture?.(active.id)) active.element.releasePointerCapture(active.id);
  };

  const cancelPointer = () => endPointer();

  const resizeByKey = (edge, dx, dy) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    scheduleFrame(resizeWorkWindow(frameRef.current, edge, dx, dy, viewport));
  };

  useEffect(() => {
    const resize = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      scheduleFrame(frameRef.current.mode === 'maximized'
        ? presetWorkWindow('maximized', frameRef.current, viewport)
        : clampWorkWindow(frameRef.current, viewport));
    };
    const keydown = event => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'w') {
        if (workSurface.bubbleEnabled === false) return;
        event.preventDefault();
        workSurface.set(!workSurface.open);
      } else if (event.key === 'Escape' && workSurface.open) {
        event.preventDefault();
        workSurface.set(false);
      }
    };
    const blur = () => cancelPointer();
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', keydown);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('blur', blur);
      cancelPointer();
      if (raf.current) window.cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, []);

  return { frame, applyPreset, toggleMaximize, beginPointer, movePointer, endPointer, cancelPointer, resizeByKey };
}

function clampBubblePoint(x, y, width, height) {
  const size = typeof BUBBLE_SIZE === 'number' ? BUBBLE_SIZE : 43;
  const maxX = Math.max(12, width - size - 12);
  const maxY = Math.max(12, height - size - 12);
  return { x: Math.max(12, Math.min(x, maxX)), y: Math.max(12, Math.min(y, maxY)) };
}

function snapBubblePoint(point, velocity, width, height) {
  const size = typeof BUBBLE_SIZE === 'number' ? BUBBLE_SIZE : 43;
  const projected = point.x + velocity.x * 140;
  return clampBubblePoint(projected + size / 2 < width / 2 ? 12 : width - size - 12, point.y + velocity.y * 100, width, height);
}

function useBubbleMotion() {
  const size = typeof BUBBLE_SIZE === 'number' ? BUBBLE_SIZE : 43;
  const [point, setPoint] = useState(() => clampBubblePoint(window.innerWidth - size - 12, window.innerHeight - size - 28, window.innerWidth, window.innerHeight));
  const [dragging, setDragging] = useState(false);
  const pointer = useRef(null), suppress = useRef(false), frame = useRef(null), queued = useRef(null);
  const flush = () => { frame.current = null; if (queued.current) { setPoint(queued.current); queued.current = null; } };
  const cancelFrame = () => { if (frame.current !== null) window.cancelAnimationFrame(frame.current); frame.current = null; queued.current = null; };
  useEffect(() => {
    const resize = () => { cancelFrame(); pointer.current = null; setDragging(false); setPoint(p => clampBubblePoint(p.x, p.y, window.innerWidth, window.innerHeight)); };
    window.addEventListener('resize', resize);
    return () => { cancelFrame(); pointer.current = null; window.removeEventListener('resize', resize); };
  }, []);
  const down = event => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    suppress.current = false;
    pointer.current = { id: event.pointerId, start: point, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, time: event.timeStamp, velocity: { x: 0, y: 0 }, moved: false };
  };
  const move = event => {
    const p = pointer.current; if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x, dy = event.clientY - p.y;
    p.moved = p.moved || Math.hypot(dx, dy) >= 4;
    const elapsed = Math.max(1, event.timeStamp - p.time);
    p.velocity = { x: (event.clientX - p.lastX) / elapsed, y: (event.clientY - p.lastY) / elapsed };
    p.lastX = event.clientX; p.lastY = event.clientY; p.time = event.timeStamp;
    if (p.moved) { setDragging(true); queued.current = clampBubblePoint(p.start.x + dx, p.start.y + dy, window.innerWidth, window.innerHeight); if (frame.current === null) frame.current = window.requestAnimationFrame(flush); }
  };
  const finish = (event, cancelled = false) => {
    const p = pointer.current; if (!p || p.id !== event.pointerId) return;
    const end = queued.current || clampBubblePoint(p.start.x + event.clientX - p.x, p.start.y + event.clientY - p.y, window.innerWidth, window.innerHeight);
    cancelFrame(); pointer.current = null; setDragging(false); suppress.current = p.moved || cancelled;
    if (p.moved) setPoint(snapBubblePoint(end, cancelled ? { x: 0, y: 0 } : p.velocity, window.innerWidth, window.innerHeight));
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    point,
    dragging,
    down,
    move,
    up: event => finish(event),
    cancel: event => finish(event, true),
    click: () => {
      if (suppress.current) { suppress.current = false; return; }
      if (isWorkEmbeddedActive()) { workSurface.set(false); focusEmbeddedWorkspace(); return; }
      workSurface.set(!workSurface.open);
    },
  };
}

function BubbleHUD({ connection }) {
  const [open, setOpen] = useState(workSurface.open);
  const [bubbleEnabled, setBubbleEnabled] = useState(() => workSurface.bubbleEnabled !== false);
  const [hovered, setHovered] = useState(false);
  const [activeTab, setActiveTab] = useState(workSurface.activeTab);
  const [sharedState, setSharedState] = useState(() => workSurface.getState ? workSurface.getState() : {});
  const hoverTimer = useRef(null);
  const windowState = useResizableWindow();
  const bubble = useBubbleMotion();
  const button = useRef(null);

  useEffect(() => {
    const listener = value => { setOpen(value); if (!value) button.current?.focus(); };
    setOpen(workSurface.open);
    workSurface.listeners.add(listener);
    const tabListener = tab => setActiveTab(tab);
    workSurface.tabListeners.add(tabListener);
    const unsubState = workSurface.subscribeState ? workSurface.subscribeState(setSharedState) : () => {};
    const unsubBubble = workSurface.subscribeBubble ? workSurface.subscribeBubble(setBubbleEnabled) : () => {};
    if (typeof callWorkRpc === 'function' && connection) {
      callWorkRpc(connection, 'getConfig').then(res => {
        if (res?.ok && typeof res.value?.showBubble === 'boolean') {
          workSurface.setBubbleEnabled(res.value.showBubble, true);
        }
      }).catch(() => {});
    }
    return () => {
      workSurface.listeners.delete(listener);
      workSurface.tabListeners.delete(tabListener);
      unsubState();
      unsubBubble();
    };
  }, [connection]);

  const openRadialTab = tab => {
    workSurface.setTab(tab);
    if (isWorkEmbeddedActive()) {
      workSurface.set(false);
      focusEmbeddedWorkspace();
    } else {
      if (windowState.frame.mode !== 'maximized' && windowState.frame.mode !== 'custom') {
        windowState.applyPreset('studio');
      }
      workSurface.set(true);
    }
    setHovered(false);
  };

  if (!bubbleEnabled) return null;

  const radialCenterOffset = typeof RADIAL_CENTER_OFFSET === 'number' ? RADIAL_CENTER_OFFSET : 10;
  const radialOffsets = (typeof computeRadialOffsets === 'function'
    ? computeRadialOffsets(bubble.point, { width: window.innerWidth, height: window.innerHeight })
    : [
        { key: 'chats', tab: 'messages', title: 'Chats', iconKey: 'chat', dx: -2, dy: -51 },
        { key: 'repo', tab: 'mesh', title: 'Repo', iconKey: 'repo', dx: -31, dy: -41 },
        { key: 'music', tab: 'music', title: 'Music', iconKey: 'music', dx: -49, dy: -16 },
        { key: 'intel', tab: 'intel', title: 'Intel', iconKey: 'intel', dx: -49, dy: 15 },
      ]
  ).map(item => ({ ...item, icon: BUBBLE_RADIAL_ICONS[item.iconKey] }));

  const effectiveTab = sharedState?.managementOpen ? 'settings' : (sharedState?.workTab || activeTab);
  const tabTitles = { messages: 'Chats', mesh: 'Git Mesh', music: 'Music', intel: 'Intel Reader', settings: 'Settings' };
  const activeTitle = (effectiveTab && tabTitles[effectiveTab]) || 'Work';

  const shouldShowPanel = open && !isWorkEmbeddedActive();
  const { x, y, w, h: panelHeight, mode } = windowState.frame;
  const panelStyle = { left: x, top: y, right: 'auto', bottom: 'auto', width: w, height: panelHeight, boxSizing: 'border-box', display: shouldShowPanel ? 'flex' : 'none', flexDirection: 'column' };
  const controlStyle = { minHeight: 26, height: 26, minWidth: 26, width: 26, padding: 0, border: '1px solid var(--wk-border-strong, rgba(255,255,255,0.12))', borderRadius: 6, background: 'var(--wk-bg-elevated, #181c24)', color: 'var(--wk-text-primary, #e6edf3)', cursor: 'pointer', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
  const edges = {
    n: { top: 0, left: 14, right: 14, height: 8, cursor: 'ns-resize' },
    s: { bottom: 0, left: 14, right: 14, height: 8, cursor: 'ns-resize' },
    e: { right: 0, top: 14, bottom: 14, width: 8, cursor: 'ew-resize' },
    w: { left: 0, top: 14, bottom: 14, width: 8, cursor: 'ew-resize' },
    ne: { top: 0, right: 0, width: 14, height: 14, cursor: 'nesw-resize' },
    nw: { top: 0, left: 0, width: 14, height: 14, cursor: 'nwse-resize' },
    se: { bottom: 0, right: 0, width: 14, height: 14, cursor: 'nwse-resize' },
    sw: { bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize' },
  };
  const maximizeIconPath = mode === 'maximized'
    ? 'M8 4h11a1 1 0 0 1 1 1v11M5 8h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z'
    : 'M5 5h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z';

  return h(React.Fragment, null, [
    h('div', { className: 'wk-global-panel', hidden: !shouldShowPanel, style: panelStyle, onKeyDown: event => { if (event.key === 'Escape') { event.stopPropagation(); workSurface.set(false); } } }, [
      h('header', {
        key: 'header',
        className: 'wk-window-header',
        onPointerDown: event => { if (!event.target.closest('button, select, input, a')) windowState.beginPointer('move', event); },
        onPointerMove: windowState.movePointer,
        onPointerUp: windowState.endPointer,
        onPointerCancel: windowState.endPointer,
        onLostPointerCapture: windowState.cancelPointer,
        style: { position: 'relative', flexShrink: 0, height: 34, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', cursor: 'move', touchAction: 'none', boxSizing: 'border-box', background: 'var(--wk-surface, #12151b)', borderBottom: '1px solid var(--wk-subtle, #202531)' },
      }, [
        h('div', {
          key: 'header-left',
          className: 'wk-header-left',
          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, pointerEvents: 'auto' },
        }, [
          h('span', {
            key: 'title',
            className: 'wk-header-title',
            style: { maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600, color: 'var(--wk-text-primary, #e6edf3)' },
            title: activeTitle,
          }, activeTitle),
        ]),
        h('div', {
          key: 'header-right',
          className: 'wk-header-right',
          style: { display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'auto', flexShrink: 0 },
        }, [
          workSurface.updateAvailable && h('button', {
            key: 'update-pill',
            type: 'button',
            style: { ...controlStyle, width: 'auto', padding: '0 8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.45)', color: '#34d399', fontWeight: 600 },
            onPointerDown: event => event.stopPropagation(),
            onClick: () => { if (typeof workSurface.onTriggerUpdate === 'function') workSurface.onTriggerUpdate(); },
            'aria-label': 'Install Work update',
          }, 'Update'),
          h('button', {
            key: 'maximize',
            type: 'button',
            style: controlStyle,
            onPointerDown: event => event.stopPropagation(),
            onClick: windowState.toggleMaximize,
            'aria-label': mode === 'maximized' ? 'Restore Work window' : 'Maximize Work window',
            title: mode === 'maximized' ? 'Restore' : 'Maximize',
          }, h(SvgIcon, { path: maximizeIconPath, size: 13 })),
          h('button', {
            key: 'close',
            type: 'button',
            style: controlStyle,
            onPointerDown: event => event.stopPropagation(),
            onClick: () => workSurface.set(false),
            'aria-label': 'Close Work panel',
            title: 'Close (Escape)',
          }, h(SvgIcon, { path: 'M18 6L6 18M6 6l12 12', size: 13 })),
        ]),
      ]),
      h('div', { key: 'content', style: { flex: 1, width: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' } }, shouldShowPanel ? h(WorkMainPanel, { connection, requestedTab: workSurface.activeTab }) : null),
      ...Object.entries(edges).map(([edge, position]) => h('div', {
        key: edge,
        role: 'separator',
        tabIndex: 0,
        'aria-label': `Resize Work window ${edge}`,
        'aria-orientation': edge === 'e' || edge === 'w' ? 'vertical' : 'horizontal',
        onPointerDown: event => { event.stopPropagation(); windowState.beginPointer(edge, event); },
        onPointerMove: windowState.movePointer,
        onPointerUp: windowState.endPointer,
        onPointerCancel: windowState.endPointer,
        onLostPointerCapture: windowState.cancelPointer,
        onKeyDown: event => {
          const delta = event.shiftKey ? 48 : 16;
          const direction = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] }[event.key];
          if (direction) { event.preventDefault(); windowState.resizeByKey(edge, ...direction); }
        },
        style: { position: 'absolute', zIndex: 31, touchAction: 'none', ...position },
      })),
    ]),
    ...radialOffsets.map(item => h('button', {
      key: `radial-${item.key}`,
      type: 'button',
      className: `wk-bubble-radial-btn${hovered && !bubble.dragging ? ' is-visible' : ''}`,
      title: item.title,
      'aria-label': `Open ${item.title}`,
      onMouseEnter: () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(true); },
      onMouseLeave: () => { hoverTimer.current = setTimeout(() => setHovered(false), 500); },
      onPointerDown: event => event.stopPropagation(),
      onMouseDown: event => { event.stopPropagation(); openRadialTab(item.tab); },
      onClick: event => { event.stopPropagation(); openRadialTab(item.tab); },
      style: {
        position: 'fixed',
        left: bubble.point.x + radialCenterOffset,
        top: bubble.point.y + radialCenterOffset,
        transform: hovered && !bubble.dragging ? `translate3d(${item.dx}px, ${item.dy}px, 0) scale(1)` : 'translate3d(0, 0, 0) scale(0.2)',
        opacity: hovered && !bubble.dragging ? 1 : 0,
        pointerEvents: hovered && !bubble.dragging ? 'auto' : 'none',
        transition: 'transform 260ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease',
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: 'var(--wk-surface, #12151b)',
        border: '1px solid var(--wk-border-strong, rgba(255, 255, 255, 0.18))',
        boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
        color: 'var(--wk-text, #e6edf3)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 100005,
        padding: 0,
      },
    }, h(SvgIcon, { path: item.icon, size: 13 }))),
    h('button', {
      key: 'bubble',
      ref: button,
      className: `wk-bubble${bubble.dragging ? ' is-dragging' : ''}`,
      style: {
        left: 0,
        top: 0,
        transform: `translate3d(${bubble.point.x}px, ${bubble.point.y}px, 0) scale(${bubble.dragging ? 1.08 : 1})`,
        transition: bubble.dragging ? 'none' : 'transform 380ms cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        cursor: bubble.dragging ? 'grabbing' : 'grab',
        boxShadow: bubble.dragging ? '0 8px 30px rgba(0,0,0,0.45)' : '0 4px 16px rgba(0,0,0,0.25)',
      },
      onMouseEnter: () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); setHovered(true); },
      onMouseLeave: () => { hoverTimer.current = setTimeout(() => setHovered(false), 500); },
      onPointerDown: bubble.down,
      onPointerMove: bubble.move,
      onPointerUp: bubble.up,
      onPointerCancel: bubble.cancel,
      onLostPointerCapture: bubble.cancel,
      'aria-label': open ? 'Close Work panel' : 'Open Work panel',
      'aria-expanded': open,
      onClick: bubble.click,
    }, h(InfinityLogo, { size: 23 })),
  ]);
}
