// Pure command/room parsing shared by the host and backend tests.
export function parseChatCommand(text) {
  if (typeof text !== 'string' || /[\r\n\0]/.test(text)) throw new Error('Expected a single slash command');
  const commit = text.match(/^\/commit ([^\s].*)$/);
  if (commit && commit[1].trim()) return { kind: 'commit', message: commit[1].trim() };
  if (text === '/diff') return { kind: 'diff' };
  if (text === '/share-repo') return { kind: 'repo' };
  throw new Error('Use /commit <message>, /diff, or /share-repo');
}

export function validateRoomId(roomId) {
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,191}$/.test(roomId)
      || (roomId.startsWith('channel:') && !/^channel:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(roomId))
      || ['__proto__', 'constructor', 'prototype'].includes(roomId)) throw new Error('Invalid roomId');
  return roomId;
}

export function dmParticipants(roomId) {
  return roomId.startsWith('dm-') ? roomId.slice(3).split('--') : [];
}
