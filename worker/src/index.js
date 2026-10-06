// src/index.js
import { handleLibraryRequest } from './library.js';
import { handleAdminRequest } from './admin.js';
import { ROOM_LIBRARY_PROTOCOL, validTrackRef, sameTrackRef } from '../../shared/room-library.js';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "gizmagick-worker" });
    }

    const libraryResponse = await handleLibraryRequest(req, env);
    if (libraryResponse) return libraryResponse;

    const adminResponse = await handleAdminRequest(req, env);
    if (adminResponse) return adminResponse;

    if (url.pathname === "/ws") {
      // Log to confirm we’re receiving the Upgrade request
      // Access cookies may also accompany public /ws requests. Never log the
      // complete headers (cookies, JWT assertions or Authorization credentials).
      console.log("[worker] /ws request:", { upgrade: req.headers.get("Upgrade"), origin: req.headers.get("Origin") });

      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      // Forward the WebSocket upgrade to our Durable Object "hub".
      const id = env.ROOM_HUB.idFromName("hub"); // single DO that manages many rooms
      const stub = env.ROOM_HUB.get(id);
      return stub.fetch(req);
    }

    return new Response("Not found", { status: 404 });
  },
};

export class RoomHub {
  /** @param {DurableObjectState} state */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.clients = new Map(); // Map<WebSocket, {id,name,role,ready,roomId}>
    this.roomState = new Map(); // Map<roomId, { selectedTrack?: string, seed?: number, queuedTrack?: string|null, queuedTrackPlayAfterRelease?: boolean|null, queuedSection?: string|null, queuedMode?: string|null, trackVolume?: number, playing?: { trackName:string, sectionName:string, serverMs:number } }>
    this.roomCommands = new Map();
    // Hibernation creates a fresh instance: restore pins and socket identities
    // before accepting commands. Keep the existing Durable Object/class name.
    for (const socket of state.getWebSockets?.() || []) {
      const user = socket.deserializeAttachment?.();
      if (user) this.clients.set(socket, user);
    }
    if (state.storage && state.blockConcurrencyWhile) state.blockConcurrencyWhile(async () => {
      this.roomState = new Map(await state.storage.get('gizmagick-room-library-v1') || []);
    });
  }

  async fetch(req) {
    // Only accept WS upgrades here
    const upgrade = req.headers.get("Upgrade");
    console.log("[RoomHub] fetch upgrade:", upgrade);
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server); // no subprotocol here
    console.log("[RoomHub] accepted websocket");
    // Important for Miniflare: do not force status:101; just attach the socket.
    return new Response(null, {
      status: 101,            // Required in Miniflare
      webSocket: client
    });
  }

  // ---- WebSocket lifecycle handlers ----
  webSocketAccept(ws) {
    try { ws.send(JSON.stringify({ type: "WELCOME", serverTimeMs: Date.now() })); } catch {}
  }

  webSocketOpen(ws) {
    // DO-side confirmation that the socket is actually open
    try { ws.send(JSON.stringify({ type: "WELCOME", serverTimeMs: Date.now() })); } catch {}
    console.log("[RoomHub] open:", ws);
  }

  webSocketMessage(ws, message) {
    let data;
    try {
      data =
        typeof message === "string" ? JSON.parse(message) :
        JSON.parse(new TextDecoder().decode(message));
    } catch (e) {
      console.log("[RoomHub] message parse error:", e);
      return;
    }

    console.log("[RoomHub] message:", data);

    if (!data || typeof data !== "object") return;

    const user = this.clients.get(ws);
    if (user?.trackSource === 'remote' && data.type !== 'HELLO') {
      // Serialize validation + mutation: an older database lookup must never
      // overwrite a newer selection/queue or race a clear/readiness message.
      const previous = this.roomCommands.get(user.roomId) || Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        if (this.clients.get(ws) !== user) return;
        await this.handlePinnedMessage(ws, data, user);
        ws.serializeAttachment?.(user);
        if (this.state.storage && data.type !== 'PING') await this.persistLibraryRooms();
      }).catch(() => this.roomError(ws, 'LIBRARY_UNAVAILABLE', 'Room library is temporarily unavailable.'));
      this.roomCommands.set(user.roomId, next);
      void next.finally(() => { if (this.roomCommands.get(user.roomId) === next) this.roomCommands.delete(user.roomId); });
      return next;
    }
    this.handleMessage(ws, data);
    const joined = this.clients.get(ws);
    if (joined) ws.serializeAttachment?.(joined);
    if (joined?.trackSource === 'remote' && this.state.storage) return this.persistLibraryRooms();
  }

  persistLibraryRooms() {
    return this.state.storage.put('gizmagick-room-library-v1', [...this.roomState].filter(([, room]) => room.trackSource === 'remote'));
  }

  roomError(ws, code, message) {
    try { ws.send(JSON.stringify({ type: 'ERROR', code, message })); } catch {}
  }

  roomContext(roomId) {
    const rs = this.roomState.get(roomId);
    return rs?.trackSource === 'remote' ? { trackRef: rs.selectedTrackRef || null, selectionId: rs.seed ?? null } : {};
  }

  async handlePinnedMessage(ws, data, user) {
    const rs = this.roomState.get(user.roomId) || {};
    if (['SET_TRACK_REQUEST', 'QUEUE_TRACK_REQUEST'].includes(data.type)) {
      if (user.role !== 'GM') return this.roomError(ws, 'FORBIDDEN', 'Only active user can select tracks.');
      if (!validTrackRef(data.trackRef)) return this.roomError(ws, 'INVALID_TRACK_REF', 'A published track/version reference is required.');
      if (!this.env.GIZMAGICK_DB) return this.roomError(ws, 'LIBRARY_UNAVAILABLE', 'Room library is not configured.');
      const row = await this.env.GIZMAGICK_DB.prepare(`SELECT t.id, t.legacy_key FROM library_tracks t
        JOIN library_track_versions v ON v.track_id = t.id WHERE t.id = ? AND v.version_id = ?
        AND t.visibility = 'public' AND t.status = 'published' AND v.status = 'published'`)
        .bind(data.trackRef.trackId, data.trackRef.versionId).first();
      if (!row) return this.roomError(ws, 'TRACK_UNAVAILABLE', 'That published track version is unavailable.');
      if (this.clients.get(ws) !== user) return;
      data = { ...data, name: row.legacy_key ?? row.id, trackRef: { trackId: row.id, versionId: data.trackRef.versionId } };
    } else if (data.type === 'SET_READY') {
      if (!sameTrackRef(data.trackRef, rs.selectedTrackRef) || data.selectionId !== rs.seed) return;
      user.readyTrackRef = data.ready ? data.trackRef : null;
      user.readySelectionId = data.ready ? data.selectionId : null;
    } else if (data.type === 'SYNC_RESPONSE') {
      if (!sameTrackRef(data.state?.trackRef, rs.selectedTrackRef) || data.state?.selectionId !== rs.seed || data.state?.trackName !== rs.selectedTrack) {
        return this.roomError(ws, 'STALE_TRACK', 'Sync does not match the room track version.');
      }
    } else if (['PLAY_REQUEST', 'PAUSE_REQUEST', 'STOP_REQUEST', 'CANCEL_STOP_REQUEST', 'RESUME_REQUEST', 'SEEK_REQUEST',
      'QUEUE_SECTION_REQUEST', 'CLEAR_SECTION_QUEUE_REQUEST', 'QUEUE_MODE_REQUEST', 'CLEAR_MODE_QUEUE_REQUEST'].includes(data.type)) {
      if (!sameTrackRef(data.trackRef, rs.selectedTrackRef) || data.selectionId !== rs.seed
          || (data.type === 'PLAY_REQUEST' && data.trackName !== rs.selectedTrack)) {
        return this.roomError(ws, 'STALE_TRACK', 'Command does not match the room track version.');
      }
    }
    this.handleMessage(ws, data);
  }

  handleMessage(ws, data) {
    switch (data.type) {
      case "HELLO": {
        const roomId = String(data.roomId || 'default');
        const source = data.trackSource === 'remote' ? 'remote' : 'legacy';
        const existing = this.roomState.get(roomId);
        const peers = [...this.clients.values()].filter(user => user.roomId === roomId);
        if ((source === 'remote' && data.roomProtocol !== ROOM_LIBRARY_PROTOCOL)
            || (existing && (existing.trackSource || 'legacy') !== source)
            || peers.some(user => (user.trackSource || 'legacy') !== source)) {
          this.roomError(ws, 'ROOM_SOURCE_MISMATCH', 'This room uses a different track source or room protocol.');
          return;
        }
        if (source === 'remote') {
          this.roomState.set(roomId, existing || { trackSource: 'remote' });
          ws.send(JSON.stringify({ type: 'ROOM_PROTOCOL', roomProtocol: ROOM_LIBRARY_PROTOCOL, trackSource: 'remote' }));
        }
        // Seed user record; roomId comes from HELLO
        const user = {
          id: crypto.randomUUID(),
          name: data.name || "Anon",
          role: data.role || "Player",
          ready: source === 'remote' ? false : !!data.ready,
          loading: source === 'remote' ? false : !data.ready && data.loading === true,
          roomId,
          trackSource: source,
        };
        this.clients.set(ws, user);
        console.log("[RoomHub] HELLO add:", user, "total:", this.clients.size);
        this.broadcastPresence(user.roomId);
        // Send current room state, including a queue made before any track was loaded.
        const rs = this.roomState.get(user.roomId);
        if (rs) {
          ws.send(JSON.stringify({
            type: "STATE",
            selectedTrack: rs.selectedTrack,
            ...(source === 'remote' ? { selectedTrackRef: rs.selectedTrackRef || null, queuedTrackRef: rs.queuedTrackRef || null, roomProtocol: ROOM_LIBRARY_PROTOCOL } : {}),
            seed: rs.seed ?? null,
            queuedSection: rs.queuedSection ?? null,
            queuedMode: rs.queuedMode ?? null,
            queuedTrack: rs.queuedTrack ?? null,
            queuedTrackPlayAfterRelease: rs.queuedTrackPlayAfterRelease ?? null,
            trackVolume: typeof rs.trackVolume === "number" ? rs.trackVolume : null,
            autoplay: rs.autoplay ?? true,
            playing: rs.playing || null
          }));
        }
        break;
      }

      case "UPDATE_IDENTITY": {
        const u = this.clients.get(ws);
        if (!u) return;
        const name = data.name || "Anon";
        const role = data.role || "Player";
        if (u.name === name && u.role === role) break;
        u.name = name;
        u.role = role;
        this.broadcastPresence(u.roomId);
        break;
      }

      case "SET_READY": {
        const u = this.clients.get(ws);
        if (!u) return;
        u.ready = !!data.ready;
        u.loading = !u.ready && data.loading === true;
        console.log("[RoomHub] SET_READY:", u.name, "→", u.ready);
        this.broadcastPresence(u.roomId);
        break;
      }

      case "PING": {
        // client -> server ping; reply immediately with server time (ms) and echo
        const u = this.clients.get(ws);
        if (!u) return;
        const payload = JSON.stringify({
          type: "PONG",
          serverTimeMs: Date.now(),
          echoClientMs: Number(data.clientMs) || 0,
        });
        try { ws.send(payload); } catch {}
        break;
      }

      case "PLAY_REQUEST": {
        // Audio Manager user requests a synchronized section start across the room
        const u = this.clients.get(ws);
        if (!u) return;
        const roomId = u.roomId;
        const serverMs = Number(data.serverMs) || (Date.now() + 2000);
        const trackName = String(data.trackName || "");
        const sectionName = String(data.sectionName || "");
        const override = !!data.override;

        // (1) Only allow active user to request play
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can play." })); } catch {}
          break;
        }

        // (2) Ready gate
        const usersInRoom = [];
        for (const [, ru] of this.clients) if (ru.roomId === roomId) usersInRoom.push(ru);
        const rs = this.roomState.get(roomId) || {};
        const notReady = usersInRoom.filter(x => !x.ready || (u.trackSource === 'remote'
          && (!sameTrackRef(x.readyTrackRef, rs.selectedTrackRef) || x.readySelectionId !== rs.seed))).map(x => x.name);

        if (!override && notReady.length > 0) {
          console.log("[RoomHub] PLAY_REQUEST rejected (not ready):", notReady);
          try {
            ws.send(JSON.stringify({
              type: "ERROR",
              code: "NOT_READY",
              message: "Not all players are ready.",
              notReady
            }));
          } catch {}
          break;
        }

        console.log("[RoomHub] PLAY_REQUEST accepted", { roomId, trackName, sectionName, serverMs, override });
        // save snapshot for late joiners
        rs.playing = { trackName, sectionName, serverMs, ...this.roomContext(roomId) };
        this.roomState.set(roomId, rs);
        const payload = JSON.stringify({ type: "PLAY", trackName, sectionName, serverMs, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) {
          if (uu.roomId === roomId) {
            try { sock.send(payload); } catch {}
          }
        }
        break;
      }

      case "PAUSE_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can pause." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        console.log("[RoomHub] PAUSE_REQUEST", { roomId });
        const payload = JSON.stringify({ type: "PAUSE", ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "STOP_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can stop." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        const fade = !!data.fade;
        const fadeSeconds = typeof data.fadeSeconds === "number" && Number.isFinite(data.fadeSeconds) && data.fadeSeconds >= 0 && data.fadeSeconds <= 30
          ? data.fadeSeconds
          : null;
        console.log("[RoomHub] STOP_REQUEST", { roomId, fade });
        const payload = JSON.stringify({ type: "STOP", fade, ...(fadeSeconds == null ? {} : { fadeSeconds }), ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        // clear playing snapshot for late joiners
        const rs = this.roomState.get(roomId) || {};
        rs.stoppingPlaying = rs.playing || null;
        rs.playing = null;
        this.roomState.set(roomId, rs);
        break;
      }

      case "CANCEL_STOP_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can cancel a stop." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        const rs = this.roomState.get(roomId) || {};
        if (rs.stoppingPlaying) rs.playing = rs.stoppingPlaying;
        rs.stoppingPlaying = null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] CANCEL_STOP_REQUEST", { roomId });
        const payload = JSON.stringify({ type: "CANCEL_STOP", ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "RESUME_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can resume." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        const serverMs = Number(data.serverMs) || (Date.now() + 2000);
        console.log("[RoomHub] RESUME_REQUEST", { roomId, serverMs });
        const payload = JSON.stringify({ type: "RESUME", serverMs, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "SEEK_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can seek." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        const positionSeconds = Math.max(0, Number(data.positionSeconds) || 0);
        const serverMs = Number(data.serverMs) || (Date.now() + 300);
        console.log("[RoomHub] SEEK_REQUEST", { roomId, positionSeconds, serverMs });
        const payload = JSON.stringify({ type: "SEEK", positionSeconds, serverMs, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "SET_TRACK_REQUEST": {
        const u = this.clients.get(ws);
        if (!u) return;
        if (u.role !== "GM") {
          try { ws.send(JSON.stringify({ type: "ERROR", code: "FORBIDDEN", message: "Only active user can set track." })); } catch {}
          break;
        }
        const roomId = u.roomId;
        const name = String(data.name || "");
        if (!name) break;
        // Generate a 32-bit seed (keep it small/int)
        const seed = (crypto.getRandomValues(new Uint32Array(1))[0]) >>> 0;
        console.log("[RoomHub] SET_TRACK_REQUEST", { roomId, name });

        // update room state
        const rs = this.roomState.get(roomId) || {};
        rs.selectedTrack = name;
        rs.seed = seed;
        if (u.trackSource === 'remote') {
          rs.selectedTrackRef = data.trackRef;
          rs.playing = null;
          rs.stoppingPlaying = null;
          rs.queuedSection = null;
          rs.queuedMode = null;
          for (const [peerSocket, peer] of this.clients) if (peer.roomId === roomId) {
            peer.ready = false;
            peer.loading = false;
            peer.readyTrackRef = null;
            peer.readySelectionId = null;
            peerSocket.serializeAttachment?.(peer);
          }
          this.broadcastPresence(roomId);
        }
        this.roomState.set(roomId, rs);

        // broadcast to room
        const payload = JSON.stringify({ type: "SET_TRACK", name, seed, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) {
          if (uu.roomId === roomId) {
            try { sock.send(payload); } catch {}
          }
        }
        break;
      }

      case "QUEUE_SECTION_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") { try { ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can queue section." })); } catch{}; break; }
        const roomId = u.roomId;
        const name = String(data.name || "");
        const rs = this.roomState.get(roomId) || {};
        rs.queuedSection = name || null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] QUEUE_SECTION_REQUEST", { roomId, name });
        const payload = JSON.stringify({ type: "QUEUE_SECTION", name, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "CLEAR_SECTION_QUEUE_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") { try { ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can clear section queue." })); } catch{}; break; }
        const roomId = u.roomId;
        const rs = this.roomState.get(roomId) || {};
        rs.queuedSection = null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] CLEAR_SECTION_QUEUE_REQUEST", { roomId });
        const payload = JSON.stringify({ type: "CLEAR_SECTION_QUEUE", ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "QUEUE_MODE_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try {
            ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can queue mode." }));
          } catch {};
          break;
        }
        const roomId = u.roomId;
        const name = String(data.name || "");
        const rs = this.roomState.get(roomId) || {};
        rs.queuedMode = name || null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] QUEUE_MODE_REQUEST", { roomId, name });
        const payload = JSON.stringify({ type: "QUEUE_MODE", name, ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "CLEAR_MODE_QUEUE_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try {
            ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can clear mode queue." }));
          } catch {};
          break;
        }
        const roomId = u.roomId;
        const rs = this.roomState.get(roomId) || {};
        rs.queuedMode = null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] CLEAR_MODE_QUEUE_REQUEST", { roomId });
        const payload = JSON.stringify({ type: "CLEAR_MODE_QUEUE", ...this.roomContext(roomId) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "QUEUE_TRACK_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") { try { ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can queue a track." })); } catch{}; break; }
        const roomId = u.roomId;
        const name = String(data.name || "");
        if (!name) break;
        const rs = this.roomState.get(roomId) || {};
        const playAfterRelease = typeof data.playAfterRelease === "boolean" ? data.playAfterRelease : null;
        rs.queuedTrack = name;
        rs.queuedTrackPlayAfterRelease = playAfterRelease;
        if (u.trackSource === 'remote') rs.queuedTrackRef = data.trackRef;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] QUEUE_TRACK_REQUEST", { roomId, name, playAfterRelease });
        const payload = JSON.stringify({ type: "QUEUE_TRACK", name, ...(playAfterRelease !== null ? { playAfterRelease } : {}),
          ...(u.trackSource === 'remote' ? { trackRef: rs.queuedTrackRef } : {}) });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "CLEAR_TRACK_QUEUE_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") { try { ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can clear the track queue." })); } catch{}; break; }
        const roomId = u.roomId;
        const rs = this.roomState.get(roomId) || {};
        rs.queuedTrack = null;
        rs.queuedTrackPlayAfterRelease = null;
        if (u.trackSource === 'remote') rs.queuedTrackRef = null;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] CLEAR_TRACK_QUEUE_REQUEST", { roomId });
        const payload = JSON.stringify({ type: "CLEAR_TRACK_QUEUE" });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "SET_TRACK_VOLUME_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try {
            ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can set track volume." }));
          } catch {}
          break;
        }
        const roomId = u.roomId;
        const vol = Math.max(0, Math.min(1, Number(data.volume)));
        const rs = this.roomState.get(roomId) || {};
        rs.trackVolume = vol;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] SET_TRACK_VOLUME_REQUEST", { roomId, vol });
        const payload = JSON.stringify({ type: "SET_TRACK_VOLUME", volume: vol });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      case "SET_AUTOPLAY_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try {
            ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can set autoplay." }));
          } catch {};
          break;
        }
        const roomId = u.roomId;
        const val = !!data.value;
        const rs = this.roomState.get(roomId) || {};
        rs.autoplay = val;
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] SET_AUTOPLAY_REQUEST", { roomId, val });
        const payload = JSON.stringify({ type: "SET_AUTOPLAY", value: val });
        for (const [sock, uu] of this.clients) if (uu.roomId === roomId) { try { sock.send(payload); } catch {} }
        break;
      }

      // Late-join precise sync: joiner → active user
      case "SYNC_REQUEST": {
        const u = this.clients.get(ws); if (!u) return;
        const roomId = u.roomId;
        // Forward to any active user in the room
        for (const [sock, uu] of this.clients) {
          if (uu.roomId === roomId && uu.role === "GM") {
            try {
              sock.send(JSON.stringify({ type: "SYNC_REQUEST", requesterId: u.id }));
            } catch {}
          }
        }
        break;
      }

      // active user → server → specific joiner only
      case "SYNC_RESPONSE": {
        const u = this.clients.get(ws); if (!u) return;
        if (u.role !== "GM") {
          try {
            ws.send(JSON.stringify({ type:"ERROR", code:"FORBIDDEN", message:"Only active user can send SYNC_RESPONSE." }));
          } catch {};
          break;
        }
        const roomId = u.roomId;
        const toId = String(data.to || "");
        // Find that specific socket
        for (const [sock, uu] of this.clients) {
          if (uu.roomId === roomId && uu.id === toId) {
            try { sock.send(JSON.stringify({ type:"SYNC_STATE", state: data.state || {} })); } catch {}
            break;
          }
        }
        break;
      }

      // Future commands (Phase 2/3): PLAY, QUEUE_SECTION, etc. go here.
      default:
        console.log("[RoomHub] unknown type:", data.type);
        break;
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    const u = this.clients.get(ws);
    console.log("[RoomHub] close:", { code, reason, wasClean, hadUser: !!u });
    if (!u) return;
    const roomId = u.roomId;
    this.clients.delete(ws);
    console.log("[RoomHub] removed user on close. size:", this.clients.size);
    this.broadcastPresence(roomId);
  }

  webSocketError(ws, err) {
    console.log("[RoomHub] error:", err);
    try { ws.close(1011, "unexpected error"); } catch {}
    const u = this.clients.get(ws);
    if (!u) return;
    const roomId = u.roomId;
    this.clients.delete(ws);
    this.broadcastPresence(roomId);
  }

  broadcastPresence(roomId) {
    const users = [];
    for (const [, u] of this.clients) {
      if (u.roomId === roomId) {
        users.push({ id: u.id, name: u.name, role: u.role, ready: u.ready, loading: !!u.loading });
      }
    }
    console.log("[RoomHub] PRESENCE →", roomId, "users:", users.map(u => u.name));
    const payload = JSON.stringify({ type: "PRESENCE", users });
    for (const [socket, u] of this.clients) {
      if (u.roomId === roomId) {
        try { socket.send(payload); } catch {}
      }
    }
  }
}

// ---- helpers ----
function json(obj, init = {}) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}
