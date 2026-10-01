import { useEffect, useRef, useState } from "react";
import UsersPanel from "./UsersPanel";
import Icon from "./Icon";
import ThemePicker from "./ThemePicker";
import useDrawerSwipe from "./useDrawerSwipe";
import { getPresenceChanges } from "../data/presence";
import { resolveTheme, themeStorageKey } from "../themes";

const LONG_PRESS_MS = 550;
const EMPTY_USERS = [];
const onlineRooms = [
  { id: "awc", name: "A Wizard's Chronicle", detail: "Online room", icon: "wand" },
  { id: "cyberspace-club", name: "Cyberspace Club", detail: "Online room", icon: "code" },
];
const privateRoom = { id: "", name: "Private Session", detail: "Offline", icon: "door", private: true };
const rooms = [...onlineRooms, privateRoom];

function readStr(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }

export default function LeftPanel({
  roomState,
  showClockOffset = false,
  setRoomId,
  onSessionSelect,
  currentRoomId,
  roomIdentities,
  setRoomIdentity,
  themeChoices = {},
  onChooseTheme,
  open,
  onOpenChange,
  onPinnedPeopleBottomChange,
}) {
  const [editingRoomId, setEditingRoomId] = useState(null);
  const [themePickerRoom, setThemePickerRoom] = useState(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [peoplePinned, setPeoplePinned] = useState(false);
  const gesture = useRef(null);
  const menuButtonRef = useRef(null);
  const peopleButtonRef = useRef(null);
  const indicatorRef = useRef(null);
  const longPressTimer = useRef(null);
  const suppressClick = useRef(false);
  const previousPresence = useRef({ roomId: currentRoomId, users: null });
  const [presenceNotices, setPresenceNotices] = useState([]);
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

  const activeRoom = rooms.find((room) => room.id === currentRoomId) || privateRoom;
  const users = roomState?.users ?? EMPTY_USERS;
  const presenceReady = !!roomState?.presenceReady;
  const latencyMs = roomState?.latencyMs ?? null;
  const offsetMs = roomState?.serverOffsetMs ?? null;
  const currentNotice = presenceNotices[0] ?? null;
  const presenceCount = presenceReady ? users.length : 0;
  const peopleExpanded = peopleOpen && !!currentRoomId && !open;
  const pinnedExpanded = peopleExpanded && peoplePinned;

  useEffect(() => {
    setPeopleOpen(false);
    setPeoplePinned(false);
  }, [currentRoomId]);

  useEffect(() => {
    if (!pinnedExpanded) {
      onPinnedPeopleBottomChange?.(0);
      return undefined;
    }
    const indicator = indicatorRef.current;
    if (!indicator) return undefined;
    const updateBottom = () => onPinnedPeopleBottomChange?.(Math.ceil(indicator.getBoundingClientRect().bottom));
    updateBottom();
    const observer = new ResizeObserver(updateBottom);
    observer.observe(indicator);
    return () => observer.disconnect();
  }, [pinnedExpanded, onPinnedPeopleBottomChange]);

  useEffect(() => {
    if (!peopleExpanded || peoplePinned) return undefined;
    const onPointerDown = (event) => {
      if (!indicatorRef.current?.contains(event.target)) setPeopleOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPeopleOpen(false);
      peopleButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [peopleExpanded, peoplePinned]);

  useEffect(() => {
    const previous = previousPresence.current;
    if (previous.roomId !== currentRoomId) {
      previousPresence.current = { roomId: currentRoomId, users: null };
      setPresenceNotices([]);
      return;
    }
    if (!presenceReady) {
      previousPresence.current = { roomId: currentRoomId, users: null };
      return;
    }

    const nextUsers = new Map(users.map((user) => [String(user.id), user.name || "Unknown"]));
    if (previous.users) {
      const changes = getPresenceChanges(previous.users, nextUsers);
      if (changes.length) setPresenceNotices((queue) => [...queue, ...changes]);
    }
    previousPresence.current = { roomId: currentRoomId, users: nextUsers };
  }, [currentRoomId, presenceReady, users]);

  useEffect(() => {
    if (!currentNotice) return undefined;
    const timer = setTimeout(() => setPresenceNotices((queue) => queue.slice(1)), 3000);
    return () => clearTimeout(timer);
  }, [currentNotice]);

  function closePanel() {
    onOpenChange(false);
    if (!peoplePinned) setPeopleOpen(false);
    setEditingRoomId(null);
    menuButtonRef.current?.focus();
  }

  const swipe = useDrawerSwipe("left", closePanel);

  function selectRoom(roomId) {
    if (roomId !== currentRoomId) onSessionSelect?.(roomId);
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
      className={`session-panel ${open ? "is-open" : "is-closed"} ${peopleExpanded ? "is-people-open" : ""} ${pinnedExpanded ? "is-people-pinned" : ""}`}
      aria-label="Session rooms"
      onPointerMove={cancelHoldOnMove}
      onPointerCancel={endTouch}
    >
      <button type="button" className="side-drawer__backdrop" aria-label="Close sessions" tabIndex={open ? 0 : -1} onClick={closePanel} />
      <div ref={indicatorRef} className={`session-panel__bar ${currentNotice ? "has-notice" : ""} ${peopleExpanded ? "is-people-open" : ""}`}>
        <div className="session-panel__indicator">
        <button
          ref={menuButtonRef}
          className="session-panel__menu"
          type="button"
          aria-label={open ? "Close sessions" : "Open sessions"}
          aria-expanded={open}
          aria-controls="sessions-drawer"
          onClick={() => {
            if (!peoplePinned) setPeopleOpen(false);
            onOpenChange(!open);
            if (open) setEditingRoomId(null);
          }}
        >
          <Icon name="menu" size={22} />
        </button>
        <div className="session-panel__current" aria-hidden={open} inert={open}>
          <span className={`session-room__icon session-room__icon--${activeRoom.private ? "private" : "online"}`}>
            <Icon name={activeRoom.icon} size={19} />
          </span>
          <span className="session-panel__current-name">{activeRoom.name}</span>
          {currentRoomId && !peopleExpanded && (
            <button
              type="button"
              className="session-panel__count session-panel__count-button"
              aria-label={`Show ${presenceCount} ${presenceCount === 1 ? "person" : "people"} in session`}
              aria-expanded={false}
              aria-controls="session-indicator-users"
              title="Show users"
              onClick={() => setPeopleOpen(true)}
            >
              <Icon name="user" size={13} />{presenceCount}
            </button>
          )}
        </div>
        <span className={`session-panel__notice ${currentNotice ? `is-${currentNotice.kind}` : ""}`} aria-live="polite" aria-atomic="true" title={currentNotice ? `${currentNotice.kind === "join" ? "+" : "−"} ${currentNotice.name}` : undefined}>
          {currentNotice && `${currentNotice.kind === "join" ? "+" : "−"} ${currentNotice.name}`}
        </span>
        {peopleExpanded && (
          <div className="session-panel__people-actions">
            <button type="button" className={`session-panel__people-action ${peoplePinned ? "is-active" : ""}`} aria-label={peoplePinned ? "Unpin users" : "Pin users"} aria-pressed={peoplePinned} title={peoplePinned ? "Unpin users" : "Pin users"} onClick={() => setPeoplePinned((value) => !value)}>
              <Icon name="pin" size={16} />
            </button>
            <button ref={peopleButtonRef} type="button" className="session-panel__people-action" aria-label="Collapse users" aria-expanded={true} aria-controls="session-indicator-users" title="Collapse users" onClick={() => { setPeopleOpen(false); setPeoplePinned(false); }}>
              <Icon name="chevronUp" size={18} />
            </button>
          </div>
        )}
        </div>
        <div id="session-indicator-users" className="session-panel__people" aria-hidden={!peopleExpanded} inert={!peopleExpanded}>
          <UsersPanel users={users} latencyMs={latencyMs} offsetMs={offsetMs} showClockOffset={showClockOffset} headerCount={presenceCount} />
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
              <div className={`session-room-wrap ${room.private ? "is-private" : ""}`} key={room.private ? "private" : room.id}>
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
            <UsersPanel users={users} latencyMs={latencyMs} offsetMs={offsetMs} showClockOffset={showClockOffset} />
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
