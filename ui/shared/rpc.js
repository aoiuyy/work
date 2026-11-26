    async function callWorkRpc(connection, action, args = {}) {
      try {
        if (connection?.rpc?.call) {
          return await connection.rpc.call('/api', `work/${action}`, { args });
        }
        const conn = connection || (typeof activeConnection !== 'undefined' ? activeConnection : null);
        if (conn && conn.rpc && typeof conn.rpc.call === 'function') {
          return await conn.rpc.call('/api', `work/${action}`, { args });
        }
        if (typeof fetch === 'function') {
          try {
            const res = await fetch(`/api/work/${action}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'client-request',
                rpcId: 'rpc-' + Math.random().toString(36).slice(2) + Date.now().toString(36),
                method: `work/${action}`,
                payload: { args },
              }),
            });
            if (res.ok) {
              const data = await res.json();
              if (data?.result) return data.result;
            }
          } catch (_) {}
        }
        return { ok: false, error: { message: 'Connection RPC unavailable' } };
      } catch (err) {
        return { ok: false, error: { message: err?.message || 'RPC call failed' } };
      }
    }

    async function copyChatText(text) {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable in this browser.');
      await navigator.clipboard.writeText(text);
    }

    const formatTime = (secs = 0) => {
      if (!secs || !Number.isFinite(secs)) return '0:00';
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return `${m}:${s < 10 ? '0' : ''}${s}`;
    };

    const buildRoomId = (myUser, peer, myGithub = '') => {
      if (peer?.isChannel) return peer.peerToken;
      if (myGithub && peer?.username) {
        return `dm-${[myGithub, peer.username].map(s => String(s).trim().toLowerCase()).sort().join('--')}`;
      }
      if (!myUser || !peer?.peerToken) return null;
      return `dm-${[myUser, peer.peerToken].sort().join('--')}`;
    };
