// src/index.js

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return json({ ok: true, worker: "wizamp-worker" });
    }

    if (url.pathname === "/ws") {
      // Log to confirm we’re receiving the Upgrade request
      console.log("[worker] /ws request headers:", Object.fromEntries(req.headers));

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

    switch (data.type) {
      case "HELLO": {
        // Seed user record; roomId comes from HELLO
        const user = {
          id: crypto.randomUUID(),
          name: data.name || "Anon",
          role: data.role || "Player",
          ready: !!data.ready,
          loading: !data.ready && data.loading === true,
          roomId: data.roomId || "default",
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
        const notReady = usersInRoom.filter(x => !x.ready).map(x => x.name);

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
        const rs = this.roomState.get(roomId) || {};
        rs.playing = { trackName, sectionName, serverMs };
        this.roomState.set(roomId, rs);
        const payload = JSON.stringify({ type: "PLAY", trackName, sectionName, serverMs });
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
        const payload = JSON.stringify({ type: "PAUSE" });
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
        const payload = JSON.stringify({ type: "STOP", fade, ...(fadeSeconds == null ? {} : { fadeSeconds }) });
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
        const payload = JSON.stringify({ type: "CANCEL_STOP" });
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
        const payload = JSON.stringify({ type: "RESUME", serverMs });
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
        const payload = JSON.stringify({ type: "SEEK", positionSeconds, serverMs });
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
        this.roomState.set(roomId, rs);

        // broadcast to room
        const payload = JSON.stringify({ type: "SET_TRACK", name, seed });
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
        const payload = JSON.stringify({ type: "QUEUE_SECTION", name });
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
        const payload = JSON.stringify({ type: "CLEAR_SECTION_QUEUE" });
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
        const payload = JSON.stringify({ type: "QUEUE_MODE", name });
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
        const payload = JSON.stringify({ type: "CLEAR_MODE_QUEUE" });
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
        this.roomState.set(roomId, rs);
        console.log("[RoomHub] QUEUE_TRACK_REQUEST", { roomId, name, playAfterRelease });
        const payload = JSON.stringify({ type: "QUEUE_TRACK", name, ...(playAfterRelease !== null ? { playAfterRelease } : {}) });
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
