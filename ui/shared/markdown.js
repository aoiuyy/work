    function renderMessageMarkdown(text) {
      const blocks = String(text || '').split(/(```[\s\S]*?(?:```|$))/g);
      return blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const code = block.slice(3).replace(/```$/, '').replace(/^[a-zA-Z0-9_+-]*\r?\n/, '');
          const language = block.slice(3).match(/^([\w+-]+)\r?\n/)?.[1] || 'code';
          const tokens = code.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|class|import|from|async|await|true|false|null|def|print)\b|\b\d+(?:\.\d+)?\b)/g);
          return h('div', { key: index, className: 'wk-chat-code' }, [
            h('div', { className: 'wk-code-header' }, [
              h('span', null, language),
              h('button', {
                type: 'button',
                className: 'wk-btn wk-btn-subtle wk-btn-sm',
                onClick: e => {
                  const button = e.currentTarget;
                  copyChatText(code).then(() => { button.textContent = 'Copied'; }).catch(() => { button.textContent = 'Copy failed'; });
                },
              }, 'Copy code'),
            ]),
            h('pre', { className: 'wk-code-block' }, h('code', null, tokens.map((token, j) =>
              j % 2 ? h('span', { key: j, className: /^['"]/.test(token) ? 'wk-code-string' : /^\d/.test(token) ? 'wk-code-number' : 'wk-code-keyword' }, token) : token))),
          ]);
        }
        return h('span', { key: index }, block.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>"`]+)/g).map((part, key) =>
          part.startsWith('`') && part.endsWith('`') ? h('code', { key }, part.slice(1, -1))
            : part.startsWith('**') && part.endsWith('**') ? h('strong', { key }, part.slice(2, -2))
              : /^https?:\/\//i.test(part) ? h('a', { key, href: part, target: '_blank', rel: 'noopener noreferrer', className: 'wk-chat-link' }, part)
                : part));
      });
    }
