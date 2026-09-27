import { useEffect, useLayoutEffect, useRef, useState } from "react";
import UsersPanel from "./UsersPanel";
import Icon from "./Icon";
import { availableThemes, resolveTheme, themeStorageKey } from "../themes";

const LS_PANEL_OPEN = "ui.panelOpen";
const LONG_PRESS_MS = 550;
const rooms = [
  { id: "", name: "Private Session", detail: "Offline", icon: "door", private: true },
  { id: "awc", name: "A Wizard's Chronicle", detail: "Online room", icon: "wand" },
  { id: "cyberspace-club", name: "Cyberspace Club", detail: "Online room", icon: "code" },
];

function persist(key, val) { try { localStorage.setItem(key, val); } catch {} }
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
  volumeExpanded = false,
  canAccessDatabase = false,
  onOpenDatabase,
  onOpenSettings,
}) {
  const [open, setOpen] = useState(() => readStr(LS_PANEL_OPEN, "true") === "true");
  const [editingRoomId, setEditingRoomId] = useState(null);
  const gesture = useRef(null);
  const longPressTimer = useRef(null);
  const suppressClick = useRef(false);
  const barRef = useRef(null);
  const roomNameMeasureRef = useRef(null);
  const [compactHeader, setCompactHeader] = useState(false);

  useEffect(() => persist(LS_PANEL_OPEN, String(open)), [open]);
  useEffect(() => () => clearTimeout(longPressTimer.current), []);

  const activeRoom = rooms.find((room) => room.id === currentRoomId) || rooms[0];
  const users = roomState?.users || [];
  const latencyMs = roomState?.latencyMs ?? null;
  const offsetMs = roomState?.serverOffsetMs ?? null;

  useLayoutEffect(() => {
    const update = () => {
      if (!volumeExpanded || open || !window.matchMedia("(max-width: 760px)").matches) {
        setCompactHeader(false);
        return;
      }
      const barLeft = barRef.current?.getBoundingClientRect().left ?? 8;
      const nameWidth = roomNameMeasureRef.current?.getBoundingClientRect().width ?? 0;
      const fullBarRight = barLeft + 44 + 28 + 9 + nameWidth + 14 + 2;
      const expandedVolumeLeft = window.innerWidth - 8 - Math.min(270, window.innerWidth - 118) - 2;
      setCompactHeader(fullBarRight + 8 > expandedVolumeLeft);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [volumeExpanded, open, activeRoom.name]);

  function closePanel() {
    setOpen(false);
    setEditingRoomId(null);
  }

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
      className={`session-panel ${open ? "is-open" : "is-closed"} ${libraryDocked ? "is-library-docked" : ""} ${compactHeader ? "is-header-compact" : ""}`}
      aria-label="Session rooms"
      onPointerMove={cancelHoldOnMove}
      onPointerCancel={endTouch}
    >
      <div ref={barRef} className="session-panel__bar">
        <button
          className="session-panel__menu"
          type="button"
          aria-label={open ? "Close rooms" : "Open rooms"}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            if (open) setEditingRoomId(null);
          }}
        >
          <Icon name="menu" size={22} />
        </button>
        <div className="session-panel__current" aria-hidden={open}>
          <span className={`session-room__icon session-room__icon--${activeRoom.private ? "private" : "online"}`}>
            <Icon name={activeRoom.icon} size={19} />
          </span>
          <span className="session-panel__current-name" aria-hidden={compactHeader}>{activeRoom.name}</span>
          <span ref={roomNameMeasureRef} className="session-panel__current-measure" aria-hidden="true">{activeRoom.name}</span>
        </div>
      </div>

      <div
        className="session-panel__drawer"
        aria-hidden={!open}
      >
        <div className="session-panel__heading">
          <span>Sessions</span>
        </div>

        <div className="session-panel__rooms">
          {rooms.map((room) => {
            const selected = room.id === currentRoomId;
            const roomIdentity = roomIdentities?.[room.id] || { role: "GM", displayName: "" };
            const themeChoice = themeChoices[room.id || "private"] ?? readStr(themeStorageKey(room.id), null);
            const themes = availableThemes();
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
                    <fieldset className="session-theme-picker">
                      <legend>Theme</legend>
                      {[...new Set(themes.map(({ group }) => group))].map((group) => (
                        <div className="session-theme-picker__group" key={group}>
                          <h4 className="session-theme-picker__group-title">{group}</h4>
                          <div className="session-theme-picker__choices">
                            {themes.filter((theme) => theme.group === group).map((theme) => (
                              <label className="session-theme-picker__choice" key={theme.id}>
                                <input
                                  type="radio"
                                  name={`theme-${room.id || "private"}`}
                                  value={theme.id}
                                  checked={resolveTheme(room.id, themeChoice).id === theme.id}
                                  onChange={() => onChooseTheme?.(room.id, theme.id)}
                                />
                                <span className={`session-theme-picker__swatch session-theme-picker__swatch--${theme.id}`} aria-hidden="true" />
                                <span>{theme.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </fieldset>
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

        <div className="session-panel__actions" aria-label="Main menu">
          {canAccessDatabase && (
            <button
              type="button"
              className="session-panel__action"
              onClick={() => {
                closePanel();
                onOpenDatabase?.();
              }}
            >
              <span className="session-panel__action-icon"><Icon name="archive" size={19} /></span>
              <span className="session-panel__action-copy">
                <strong>Database</strong>
                <small>Manage tracks and display names</small>
              </span>
              <Icon name="chevronRight" size={17} />
            </button>
          )}

          <button
            type="button"
            className="session-panel__action"
            onClick={() => {
              closePanel();
              onOpenSettings?.();
            }}
          >
            <span className="session-panel__action-icon"><Icon name="settings" size={19} /></span>
            <span className="session-panel__action-copy">
              <strong>Settings</strong>
              <small>Playback and interface options</small>
            </span>
            <Icon name="chevronRight" size={17} />
          </button>
        </div>
      </div>
    </aside>
  );
}
