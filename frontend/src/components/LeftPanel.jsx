import { useEffect, useRef, useState } from "react";
import UsersPanel from "./UsersPanel";
import Icon from "./Icon";
import ThemePicker from "./ThemePicker";
import useDrawerSwipe from "./useDrawerSwipe";
import { resolveTheme, themeStorageKey } from "../themes";

const LONG_PRESS_MS = 550;
const rooms = [
  { id: "", name: "Private Session", detail: "Offline", icon: "door", private: true },
  { id: "awc", name: "A Wizard's Chronicle", detail: "Online room", icon: "wand" },
  { id: "cyberspace-club", name: "Cyberspace Club", detail: "Online room", icon: "code" },
];

function readStr(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }

export default function LeftPanel({
  roomState,
  setRoomId,
  currentRoomId,
  roomIdentities,
  setRoomIdentity,
  themeChoices = {},
  onChooseTheme,
  libraryDocked = false,
  open,
  onOpenChange,
}) {
  const [editingRoomId, setEditingRoomId] = useState(null);
  const [themePickerRoom, setThemePickerRoom] = useState(null);
  const gesture = useRef(null);
  const menuButtonRef = useRef(null);
  const longPressTimer = useRef(null);
  const suppressClick = useRef(false);
  useEffect(() => () => clearTimeout(longPressTimer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const activeRoom = rooms.find((room) => room.id === currentRoomId) || rooms[0];
  const users = roomState?.users || [];
  const latencyMs = roomState?.latencyMs ?? null;
  const offsetMs = roomState?.serverOffsetMs ?? null;

  function closePanel() {
    onOpenChange(false);
    setEditingRoomId(null);
    menuButtonRef.current?.focus();
  }

  const swipe = useDrawerSwipe("left", closePanel);

  function selectRoom(roomId) {
    setRoomId(roomId);
    closePanel();
  }

  function beginTouch(event, room) {
    if (event.pointerType !== "touch") return;
    if (gesture.current) return;
    gesture.current = { x: event.clientX, y: event.clientY, longPressed: false };
    clearTimeout(longPressTimer.current);
    if (room) {
      longPressTimer.current = setTimeout(() => {
        if (!gesture.current) return;
        gesture.current.longPressed = true;
        setEditingRoomId(room.id);
        navigator.vibrate?.(12);
      }, LONG_PRESS_MS);
    }
  }

  function cancelHoldOnMove(event) {
    if (!gesture.current || event.pointerType !== "touch") return;
    if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 10) {
      clearTimeout(longPressTimer.current);
    }
  }

  function endTouch() {
    clearTimeout(longPressTimer.current);
    const wasLongPress = gesture.current?.longPressed;
    gesture.current = null;
    if (wasLongPress) {
      suppressClick.current = true;
      setTimeout(() => { suppressClick.current = false; }, 0);
    }
    return wasLongPress;
  }

  return (
    <aside
      className={`session-panel ${open ? "is-open" : "is-closed"} ${libraryDocked ? "is-library-docked" : ""}`}
      aria-label="Session rooms"
      onPointerMove={cancelHoldOnMove}
      onPointerCancel={endTouch}
    >
      <button type="button" className="side-drawer__backdrop" aria-label="Close sessions" tabIndex={open ? 0 : -1} onClick={closePanel} />
      <div className="session-panel__bar">
        <button
          ref={menuButtonRef}
          className="session-panel__menu"
          type="button"
          aria-label={open ? "Close sessions" : "Open sessions"}
          aria-expanded={open}
          aria-controls="sessions-drawer"
          onClick={() => {
            onOpenChange(!open);
            if (open) setEditingRoomId(null);
          }}
        >
          <Icon name="menu" size={22} />
        </button>
        <div className="session-panel__current" aria-hidden={open}>
          <span className={`session-room__icon session-room__icon--${activeRoom.private ? "private" : "online"}`}>
            <Icon name={activeRoom.icon} size={19} />
          </span>
          <span className="session-panel__current-name">{activeRoom.name}</span>
        </div>
      </div>

      <div
        id="sessions-drawer"
        className={`session-panel__drawer ${swipe.dragging ? "is-dragging" : ""}`}
        aria-hidden={!open}
        inert={!open}
        style={swipe.style}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        onClickCapture={swipe.onClickCapture}
      >
        <div className="session-panel__heading">
          <span>Sessions</span>
        </div>

        <div className="session-panel__rooms">
          {rooms.map((room) => {
            const selected = room.id === currentRoomId;
            const roomIdentity = roomIdentities?.[room.id] || { role: "GM", displayName: "" };
            const themeChoice = themeChoices[room.id || "private"] ?? readStr(themeStorageKey(room.id), null);
            const currentTheme = resolveTheme(room.id, themeChoice);
            return (
              <div className="session-room-wrap" key={room.private ? "private" : room.id}>
                <button
                  type="button"
                  className={`session-room ${selected ? "is-selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    if (!suppressClick.current) selectRoom(room.id);
                  }}
                  onPointerDown={(event) => beginTouch(event, room)}
                  onPointerUp={(event) => {
                    if (event.pointerType === "touch" && endTouch()) event.preventDefault();
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <span className={`session-room__icon session-room__icon--${room.private ? "private" : "online"}`}>
                    <Icon name={room.icon} size={22} />
                  </span>
                  <span className="session-room__copy">
                    <strong>{room.name}</strong>
                    <small>{room.detail}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="session-room__more"
                  aria-label={`Options for ${room.name}`}
                  aria-expanded={editingRoomId === room.id}
                  aria-controls={`session-options-${room.id || "private"}`}
                  onClick={() => setEditingRoomId((value) => value === room.id ? null : room.id)}
                >
                  <Icon name="moreVertical" size={20} />
                </button>

                  <div
                    id={`session-options-${room.id || "private"}`}
                    className={`session-identity ${editingRoomId === room.id ? "is-visible" : ""}`}
                    aria-hidden={editingRoomId !== room.id}
                    inert={editingRoomId !== room.id}
                  >
                    {!room.private && (
                      <>
                        <label>
                          <span>Display name</span>
                          <input
                            value={roomIdentity.displayName}
                            onChange={(event) => setRoomIdentity(room.id, { displayName: event.target.value })}
                            placeholder="Your name"
                            spellCheck="false"
                          />
                        </label>
                        <label>
                          <span>Role</span>
                          <select
                            value={roomIdentity.role}
                            onChange={(event) => setRoomIdentity(room.id, { role: event.target.value })}
                          >
                            <option value="GM">Audio Manager</option>
                            <option value="PASSIVE_BTS">BTS</option>
                            <option value="PASSIVE">Player</option>
                          </select>
                        </label>
                      </>
                    )}
                    <button type="button" className="session-theme-launch" onClick={() => setThemePickerRoom(room)}>
                      <span className="session-theme-launch__label">Theme</span>
                      <span className={`session-theme-picker__swatch session-theme-picker__swatch--${currentTheme.id}`} aria-hidden="true" />
                      <strong>{currentTheme.name}</strong>
                      <Icon name="chevronRight" size={16} />
                    </button>
                  </div>
              </div>
            );
          })}
        </div>

        {currentRoomId && (
          <div className="session-panel__presence">
            <UsersPanel users={users} latencyMs={latencyMs} offsetMs={offsetMs} />
          </div>
        )}

      </div>
      {themePickerRoom && (
        <ThemePicker
          key={themePickerRoom.id || "private"}
          room={themePickerRoom}
          initialThemeId={resolveTheme(
            themePickerRoom.id,
            themeChoices[themePickerRoom.id || "private"] ?? readStr(themeStorageKey(themePickerRoom.id), null),
          ).id}
          onCancel={() => setThemePickerRoom(null)}
          onApply={(themeId) => {
            onChooseTheme?.(themePickerRoom.id, themeId);
            setThemePickerRoom(null);
          }}
        />
      )}
    </aside>
  );
}
