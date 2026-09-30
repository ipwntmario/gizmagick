// src/net/useRoom.js
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const ONLINE_ENV = (import.meta.env?.VITE_ONLINE_MODE === 'true');
const WS_URL = import.meta.env?.VITE_WS_URL || "";
const PING_INTERVAL_MS = 5000;

export function useRoom({
  onlineEnabled, roomId, displayName, role,
  onPlay, onSetTrack, onPause, onStop, onCancelStop, onResume, onSeek,
  onQueueSection, onClearSectionQueue, onQueueMode, onClearModeQueue,
  onQueueTrack, onClearTrackQueue,
  onSetTrackVolume,
  onSetAutoplay,
  onSyncRequest, onSyncState
} = {}) {
  const shouldOnline = ONLINE_ENV && onlineEnabled && !!WS_URL;

  // Keep refs so we don't reconnect on every render
  const onPlayRef = useRef(onPlay);
  useEffect(() => { onPlayRef.current = onPlay; }, [onPlay]);
  const onSetTrackRef = useRef(onSetTrack);
  useEffect(() => { onSetTrackRef.current = onSetTrack; }, [onSetTrack]);
  const onPauseRef = useRef(onPause);
  useEffect(() => { onPauseRef.current = onPause; }, [onPause]);
  const onStopRef = useRef(onStop);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);
  const onCancelStopRef = useRef(onCancelStop);
  useEffect(() => { onCancelStopRef.current = onCancelStop; }, [onCancelStop]);
  const onResumeRef = useRef(onResume);
  useEffect(() => { onResumeRef.current = onResume; }, [onResume]);
  const onSeekRef = useRef(onSeek);
  useEffect(() => { onSeekRef.current = onSeek; }, [onSeek]);
  const onQueueSectionRef = useRef(onQueueSection);
  useEffect(() => { onQueueSectionRef.current = onQueueSection; }, [onQueueSection]);
  const onClearSectionQueueRef = useRef(onClearSectionQueue);
  useEffect(() => { onClearSectionQueueRef.current = onClearSectionQueue; }, [onClearSectionQueue]);
  const onQueueModeRef = useRef(onQueueMode);
  useEffect(() => { onQueueModeRef.current = onQueueMode; }, [onQueueMode]);
  const onClearModeQueueRef = useRef(onClearModeQueue);
  useEffect(() => { onClearModeQueueRef.current = onClearModeQueue; }, [onClearModeQueue]);
  const onQueueTrackRef = useRef(onQueueTrack);
  useEffect(() => { onQueueTrackRef.current = onQueueTrack; }, [onQueueTrack]);
  const onClearTrackQueueRef = useRef(onClearTrackQueue);
  useEffect(() => { onClearTrackQueueRef.current = onClearTrackQueue; }, [onClearTrackQueue]);
  const onSetTrackVolumeRef = useRef(onSetTrackVolume);
  useEffect(() => { onSetTrackVolumeRef.current = onSetTrackVolume; }, [onSetTrackVolume]);
  const onSetAutoplayRef = useRef(onSetAutoplay);
  useEffect(() => { onSetAutoplayRef.current = onSetAutoplay; }, [onSetAutoplay]);
  const onSyncRequestRef = useRef(onSyncRequest);
  useEffect(() => { onSyncRequestRef.current = onSyncRequest; }, [onSyncRequest]);
  const onSyncStateRef = useRef(onSyncState);
  useEffect(() => { onSyncStateRef.current = onSyncState; }, [onSyncState]);


  const [connected, setConnected] = useState(false);
  const [users, setUsers] = useState([]);
  const [presenceRoomId, setPresenceRoomId] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [latencyMs, setLatencyMs] = useState(null);
  const [offsetMs, setOffsetMs] = useState(0); // serverNow ≈ Date.now() + offsetMs

  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const pingTimer = useRef(null);
  const lastReadyRef = useRef(null);
  const lastLoadingRef = useRef(false);
  const connIdRef = useRef(0);
  const startedRef = useRef(false);
  const identityRef = useRef({ displayName, role });
  identityRef.current = { displayName, role };

  // NTP-ish smoothing
  const updateOffset = useCallback((rtt, serverTimeMs) => {
    const clientNow = Date.now();
    const oneWay = rtt / 2;
    const estimateServerNow = serverTimeMs + oneWay; // server timestamp likely at mid-RTT
    const newOffset = estimateServerNow - clientNow;
    // EMA smoothing
    setLatencyMs(prev => prev == null ? Math.round(oneWay) : Math.round(prev * 0.8 + oneWay * 0.2));
    setOffsetMs(prev => prev * 0.8 + newOffset * 0.2);
  }, []);

  const serverNowMs = useCallback(() => Date.now() + offsetMs, [offsetMs]);

  const connect = useCallback(() => {
    if (!shouldOnline || !roomId) return;
    setPresenceRoomId(null);

    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }

    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    const myId = ++connIdRef.current;

    ws.onopen = () => {
      if (connIdRef.current !== myId) return;
      setConnected(true);
      console.log("[room] OPEN");
      // HELLO (seed ready)
      const { displayName: currentName, role: currentRole } = identityRef.current;
      ws.send(JSON.stringify({
        type: "HELLO",
        roomId,
        name: currentName || "Anon",
        role: currentRole || "Player",
        clientVersion: "phase2",
        ready: lastReadyRef.current === null ? false : !!lastReadyRef.current,
        loading: lastLoadingRef.current,
      }));
      console.log("[room] → HELLO", { roomId, name: currentName || "Anon", role: currentRole, ready: lastReadyRef.current });

      if (lastReadyRef.current !== null) {
        ws.send(JSON.stringify({ type: "SET_READY", ready: !!lastReadyRef.current, loading: lastLoadingRef.current }));
        console.log("[room] → SET_READY", lastReadyRef.current);
      }
      // start ping loop
      pingTimer.current = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const clientMs = Date.now();
        // send PING with echo
        ws.send(JSON.stringify({ type: "PING", clientMs }));
        // wait for PONG to compute rtt/offset (handled in onmessage)
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (ev) => {
      if (connIdRef.current !== myId) return;
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      console.log("[room] ←", data.type, data);
      if (data.type === "PRESENCE" && Array.isArray(data.users)) {
        setUsers(data.users);
        setPresenceRoomId(roomId);
      } else if (data.type === "PONG") {
        const recv = Date.now();
        const clientSend = Number(data.echoClientMs) || recv;
        const rtt = Math.max(0, recv - clientSend);
        updateOffset(rtt, Number(data.serverTimeMs) || recv, clientSend);
      } else if (data.type === "SET_TRACK") {
        const name = String(data.name || "");
        const seed = (data.seed ?? null);
        console.log("[room] ← SET_TRACK", { name, seed });
        if (name) onSetTrackRef.current?.({ name, seed });
      } else if (data.type === "STATE") {
        const name = String(data.selectedTrack || "");
        const seed = (data.seed ?? null);
        console.log("[room] ← STATE", { name, seed });
        if (name) onSetTrackRef.current?.({ name, seed });
        // hydrate queued UI from snapshot (optional)
        if (data.queuedSection != null) onQueueSectionRef.current?.(String(data.queuedSection));
        if (data.queuedMode != null) onQueueModeRef.current?.(String(data.queuedMode));
        if (data.queuedTrack != null) onQueueTrackRef.current?.(String(data.queuedTrack), data.queuedTrackPlayAfterRelease);
        if (typeof data.trackVolume === "number") {
          onSetTrackVolumeRef.current?.(data.trackVolume);
        }
        if (typeof data.autoplay === "boolean") {
          onSetAutoplayRef.current?.(!!data.autoplay);
        }
        if (data.playing && data.playing.trackName && data.playing.sectionName && data.playing.serverMs) {
          // Minimal catch-up: let App decide how to handle late-join play snapshot.
          // You can either re-broadcast PLAY or do a local catch-up; we surface it via onPlay.
          onPlayRef.current?.({
            trackName: String(data.playing.trackName),
            sectionName: String(data.playing.sectionName),
            serverMs: Number(data.playing.serverMs)
          });
        }
      } else if (data.type === "PLAY") {
        onPlayRef.current?.({ trackName: data.trackName, sectionName: data.sectionName, serverMs: Number(data.serverMs) });
      } else if (data.type === "PAUSE") {
        onPauseRef.current?.();
      } else if (data.type === "STOP") {
        onStopRef.current?.(!!data.fade);
      } else if (data.type === "CANCEL_STOP") {
        onCancelStopRef.current?.();
      } else if (data.type === "RESUME") {
        onResumeRef.current?.(Number(data.serverMs));
      } else if (data.type === "SEEK") {
        onSeekRef.current?.({ positionSeconds: Number(data.positionSeconds), serverMs: Number(data.serverMs) });
      } else if (data.type === "QUEUE_SECTION") {
        onQueueSectionRef.current?.(String(data.name || ""));
      } else if (data.type === "CLEAR_SECTION_QUEUE") {
        onClearSectionQueueRef.current?.();
      } else if (data.type === "QUEUE_MODE") {
        onQueueModeRef.current?.(String(data.name || ""));
      } else if (data.type === "CLEAR_MODE_QUEUE") {
        onClearModeQueueRef.current?.();
      } else if (data.type === "QUEUE_TRACK") {
        onQueueTrackRef.current?.(String(data.name || ""), data.playAfterRelease);
      } else if (data.type === "CLEAR_TRACK_QUEUE") {
        onClearTrackQueueRef.current?.();
      } else if (data.type === "SET_TRACK_VOLUME") {
        onSetTrackVolumeRef.current?.(Math.max(0, Math.min(1, Number(data.volume))));
      } else if (data.type === "SET_AUTOPLAY") {
        onSetAutoplayRef.current?.(!!data.value);
      } else if (data.type === "SYNC_REQUEST") {
        // GM receives this; app will read precise position and answer
        onSyncRequestRef.current?.(String(data.requesterId || ""));
      } else if (data.type === "SYNC_STATE") {
        onSyncStateRef.current?.(data.state || {});
      } else if (data.type === "ERROR") {
        setLastError({ code: data.code, message: data.message, notReady: data.notReady });
        console.warn("[room] ERROR", data);
      }
    };

    ws.onclose = (evt) => {
      if (connIdRef.current !== myId) return;
      setConnected(false);
      setPresenceRoomId(null);
      console.log("[room] socket closed; will retry in 2000ms");
      console.log("[room] CLOSE", { code: evt.code, reason: evt.reason, wasClean: evt.wasClean });
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      if (shouldOnline && roomId) {
        reconnectTimer.current = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => { /* rely on onclose */ };
  }, [shouldOnline, roomId, updateOffset]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "UPDATE_IDENTITY", name: displayName || "Anon", role: role || "Player" }));
  }, [displayName, role]);

  useLayoutEffect(() => {
    if (!shouldOnline || !roomId) return;
    if (startedRef.current) return;
    startedRef.current = true;
    connect();
    const connectionGeneration = connIdRef;
    return () => {
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      ++connectionGeneration.current; // Invalidate handlers before closing; cleanup must not reconnect.
      const ws = wsRef.current;
      wsRef.current = null;
      setConnected(false);
      setUsers([]);
      setPresenceRoomId(null);
      if (ws) { try { ws.close(); } catch {} }
      startedRef.current = false;
    };
  }, [shouldOnline, roomId, connect]);

  const setReady = useCallback((ready, { loading = false } = {}) => {
    lastReadyRef.current = !!ready;
    lastLoadingRef.current = !ready && !!loading;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SET_READY", ready: !!ready, loading: lastLoadingRef.current }));
  }, []);

  const requestPlay = useCallback(({ trackName, sectionName, delayMs = 2000, override = false }) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const serverMs = serverNowMs() + Math.max(0, delayMs);
    ws.send(JSON.stringify({ type: "PLAY_REQUEST", trackName, sectionName, serverMs, override }));
  }, [serverNowMs]);

  const requestPause = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "PAUSE_REQUEST" }));
  }, []);

  const requestStop = useCallback((fade = true) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "STOP_REQUEST", fade }));
  }, []);

  const requestCancelStop = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "CANCEL_STOP_REQUEST" }));
  }, []);

  const requestResume = useCallback(({ delayMs = 2000 } = {}) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const serverMs = serverNowMs() + Math.max(0, delayMs);
    ws.send(JSON.stringify({ type: "RESUME_REQUEST", serverMs }));
  }, [serverNowMs]);

  const requestSeek = useCallback(({ positionSeconds, delayMs = 300 } = {}) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const seconds = Math.max(0, Number(positionSeconds) || 0);
    const serverMs = serverNowMs() + Math.max(0, delayMs);
    ws.send(JSON.stringify({ type: "SEEK_REQUEST", positionSeconds: seconds, serverMs }));
  }, [serverNowMs]);

  const requestSetTrack = useCallback((name) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SET_TRACK_REQUEST", name }));
  }, []);

  const requestQueueSection = useCallback((name) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "QUEUE_SECTION_REQUEST", name }));
  }, []);

  const requestClearSectionQueue = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "CLEAR_SECTION_QUEUE_REQUEST" }));
  }, []);

  const requestQueueMode = useCallback((name) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "QUEUE_MODE_REQUEST", name }));
  }, []);

  const requestClearModeQueue = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "CLEAR_MODE_QUEUE_REQUEST" }));
  }, []);

  const requestQueueTrack = useCallback((name, { playAfterRelease = null } = {}) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "QUEUE_TRACK_REQUEST", name, ...(typeof playAfterRelease === "boolean" ? { playAfterRelease } : {}) }));
  }, []);

  const requestClearTrackQueue = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "CLEAR_TRACK_QUEUE_REQUEST" }));
  }, []);

  const requestSetTrackVolume = useCallback((volume) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SET_TRACK_VOLUME_REQUEST", volume: Math.max(0, Math.min(1, Number(volume))) }));
  }, []);

  const requestSetAutoplay = useCallback((value) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SET_AUTOPLAY_REQUEST", value: !!value }));
  }, []);

  const requestSync = useCallback(() => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SYNC_REQUEST" }));
  }, []);


  const sendSyncResponse = useCallback((toId, state) => {
    const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "SYNC_RESPONSE", to: String(toId), state }));
  }, []);


  const allReady = users.length > 0 && users.every(u => !!u.ready);

  return {
    onlineActive: shouldOnline && !!roomId,
    connected,
    users,
    presenceReady: connected && !!roomId && presenceRoomId === roomId,
    roomId,
    setReady,
    requestPlay,
    requestPause,
    requestStop,
    requestCancelStop,
    requestResume,
    requestSeek,
    requestSetTrack,
    requestQueueSection,
    requestClearSectionQueue,
    requestQueueMode,
    requestClearModeQueue,
    requestQueueTrack,
    requestClearTrackQueue,
    requestSetTrackVolume,
    requestSetAutoplay,
    requestSync,
    sendSyncResponse,
    serverNowMs,
    latencyMs,
    offsetMs,
    allReady,
    lastError,
  };
}
