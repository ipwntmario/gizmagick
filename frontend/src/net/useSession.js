import { useCallback, useEffect, useState } from 'react';

function read(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
}

export function normalizeRole(role) {
  switch (String(role).toLowerCase()) {
    case 'passive_bts': case 'passive-bts': return 'PASSIVE_BTS';
    case 'passive': case 'player': return 'PASSIVE';
    default: return 'GM';
  }
}

const roomRoleKey = (roomId) => `wizamp.room.${roomId}.role`;
const roomNameKey = (roomId) => `wizamp.room.${roomId}.displayName`;

function readIdentity(roomId) {
  // The old global keys are fallbacks so existing users keep their identity.
  return {
    role: normalizeRole(read(roomRoleKey(roomId), read('wizamp.role', read('wizamp_role', 'GM')))),
    displayName: read(roomNameKey(roomId), read('wizamp.displayName', read('wizamp_displayName', ''))),
  };
}

export function useSession() {
  const [roomId, setRoomId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const savedRoomId = read('ui.roomChoice', 'private');
    return params.has('room') ? params.get('room') : savedRoomId === 'private' ? '' : savedRoomId;
  });
  const [roomIdentities, setRoomIdentities] = useState(() => ({
    awc: readIdentity('awc'),
    'cyberspace-club': readIdentity('cyberspace-club'),
  }));

  const setRoomIdentity = useCallback((targetRoomId, patch) => {
    if (!targetRoomId) return;
    setRoomIdentities((current) => {
      const previous = current[targetRoomId] || readIdentity(targetRoomId);
      const next = {
        role: normalizeRole(patch.role ?? previous.role),
        displayName: patch.displayName ?? previous.displayName,
      };
      write(roomRoleKey(targetRoomId), next.role);
      write(roomNameKey(targetRoomId), next.displayName);
      return { ...current, [targetRoomId]: next };
    });
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (roomId) url.searchParams.set('room', roomId);
    else url.searchParams.delete('room');
    window.history.replaceState({}, '', url);
    write('ui.roomChoice', roomId || 'private');
    if (roomId) {
      setRoomIdentities((current) => current[roomId] ? current : { ...current, [roomId]: readIdentity(roomId) });
    }
  }, [roomId]);

  const identity = roomId ? (roomIdentities[roomId] || readIdentity(roomId)) : { role: 'GM', displayName: '' };
  const setRole = useCallback((role) => {
    if (roomId) setRoomIdentity(roomId, { role });
  }, [roomId, setRoomIdentity]);
  const setDisplayName = useCallback((displayName) => {
    if (roomId) setRoomIdentity(roomId, { displayName });
  }, [roomId, setRoomIdentity]);

  return {
    roomId, setRoomId, onlineEnabled: !!roomId,
    role: identity.role, setRole,
    displayName: identity.displayName, setDisplayName,
    roomIdentities, setRoomIdentity,
  };
}
