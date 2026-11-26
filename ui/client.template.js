// Work v2.0.1 Client Plugin for @local/work-v2
// Discord-Style P2P Collaboration & Streamlined Saul Music Hub
// Hallmark Dark Obsidian & Industrial Slate Engineering Standard (Impeccable Anti-Slop)

window.__ModuleLoader__.load({
  id: '@local/work-v2',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;
    let activeConnection = null;

    const STYLE_ID = '@local/work-v2/styles-v4';
    if (typeof document !== 'undefined') {
      let styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ID;
        document.head.appendChild(styleEl);
      }
      styleEl.textContent = `
/* WORK_STYLES */
      `;
    }

/* WORK_COMPONENTS */

    function SidebarWorkIcon() {
      return h('div', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px' },
      }, h(InfinityLogo, { size: 18 }));
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        activeConnection = ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : null);
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: 'work', order: 15, label: () => 'Work' }, () => h(SidebarWorkIcon))
        );
        ctx.slots.inject('main', () =>
          ctx.slots.register({
            name: 'main', key: 'work',
            inject: () => ({ ctx, connection: ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : null) }),
          }, props => h(WorkEntry, props))
        );
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'work-bubble', inject: () => ({ connection: ctx.connection || (typeof ctx.get === 'function' ? ctx.get('connection') : null) }) }, props => h(BubbleHUD, props))
        );
      },
    };
  },
});
