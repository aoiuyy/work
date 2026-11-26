    function SvgIcon({ path, size = 16, color = 'currentColor', className = '' }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: color, strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round',
        className, style: { display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 },
      }, h('path', { d: path }));
    }

    const Icons = {
      Chat: 'M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z',
      Search: 'M21 21l-4.35-4.35m0 0A7.5 7.5 0 1010.5 18a7.5 7.5 0 006.15-3.35z',
      Github: 'M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z',
      AppleMusic: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12-2a3 3 0 11-6 0 3 3 0 016 0z',
      Attach: 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
      RepeatOne: 'M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3m9-11v6m-1-5l1-1',
      Play: 'M5 3l14 9-14 9V3z',
      Pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
      Stop: 'M5 5h14v14H5z',
      SkipNext: 'M5 4l10 8-10 8V4zM19 5v14',
      SkipPrev: 'M19 20L9 12l10-8v16zM5 19V5',
      Repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3',
      Volume: 'M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07',
      VolumeMuted: 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
      Folder: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z',
      GitCommit: 'M12 3a9 9 0 00-9 9 9 9 0 009 9 9 9 0 009-9 9 9 0 00-9-9zm0 5a4 4 0 110 8 4 4 0 010-8z',
      GitPull: 'M18 13v6a2 2 0 01-2 2H8a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h3a2 2 0 012 2v2',
      Download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
      Upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
      Send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
      Close: 'M18 6L6 18M6 6l12 12',
      Refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15',
      Share: 'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
      Wifi: 'M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01',
      Music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zm12 0a3 3 0 11-6 0 3 3 0 016 0z',
      Up: 'M18 15l-6-6-6 6',
      Down: 'M6 9l6 6 6-6',
      Plus: 'M12 5v14M5 12h14',
      Settings: 'M12 8a4 4 0 100 8 4 4 0 000-8zM9 3l-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-2z',
      Link: 'M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-2 2M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l2-2',
      Globe: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 0c2.5 3 4 6.5 4 10s-1.5 7-4 10m0-20c-2.5 3-4 6.5-4 10s1.5 7 4 10m-9-10h18',
      Tree: 'M12 2v6m0 0l-5 5m5-5l5 5m-9 7h8',
      Diagram: 'M3 3h7v7H3V3zm11 0h7v7h-7V3zm-11 11h7v7H3v-7zm11 0h7v7h-7v-7z',
      Canvas: 'M4 4h16v16H4V4zm4 4h8v8H8V8z',
      Edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
    };

    const ChatGlyphs = {
      thumbs: 'M7 10v11H3V10h4Zm0 0 5-8c3 0 2 5 2 6h5c2 0 2 2 1 4l-3 9H7',
      heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
      fire: 'M12 3c2 5 7 6 7 12a7 7 0 0 1-14 0c0-3 2-5 3-6 0 4 2 4 2 4s3-4 2-10Z',
      reply: 'm9 5-7 7 7 7M2 12h13a6 6 0 0 1 6 6',
      pin: 'm16 3 5 5-4 1-4 7-3-3-7 8M4 12l8-5 1-4',
      copy: 'M9 9h12v12H9zM15 9V3H3v12h6',
      trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
      mic: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    };

    const BUBBLE_RADIAL_ICONS = {
      chat: Icons.Chat,
      repo: Icons.Github,
      music: Icons.AppleMusic,
      intel: Icons.Globe,
    };

    // Horizontal Infinity Nexus Orbit Logo
    function InfinityLogo({ size = 20 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 32 32', fill: 'none',
        className: 'wk-brand-logo', style: { display: 'inline-block', flexShrink: 0 },
      }, [
        h('defs', { key: 'd' }, [
          h('linearGradient', { id: 'wkOrbitGrad1', x1: '0%', y1: '0%', x2: '100%', y2: '100%' }, [
            h('stop', { offset: '0%', stopColor: 'var(--wk-text)' }),
            h('stop', { offset: '100%', stopColor: 'var(--wk-text)' }),
          ]),
          h('linearGradient', { id: 'wkOrbitGrad2', x1: '100%', y1: '0%', x2: '0%', y2: '100%' }, [
            h('stop', { offset: '0%', stopColor: '#10b981' }),
            h('stop', { offset: '100%', stopColor: 'var(--wk-text)' }),
          ]),
        ]),
        h('ellipse', { key: 'e1', cx: '11', cy: '16', rx: '8', ry: '5.5', transform: 'rotate(-25 11 16)', stroke: 'url(#wkOrbitGrad1)', strokeWidth: '2.4', strokeLinecap: 'round' }),
        h('ellipse', { key: 'e2', cx: '21', cy: '16', rx: '8', ry: '5.5', transform: 'rotate(25 21 16)', stroke: 'url(#wkOrbitGrad2)', strokeWidth: '2.4', strokeLinecap: 'round' }),
        h('circle', { key: 'c', cx: '16', cy: '16', r: '2.5', fill: 'var(--wk-text)' }),
      ]);
    }
