import { useEffect, useRef } from "react";
import Icon from "./Icon";
import VolumeControl from "./VolumeControl";
import useDrawerSwipe from "./useDrawerSwipe";

export default function AppMenu({
  open,
  onOpenChange,
  canAccessDatabase,
  onOpenDatabase,
  onOpenSettings,
  volumeExpanded,
  onVolumeExpandedChange,
  volume,
  onVolumeChange,
  muted,
  onMutedChange,
}) {
  const triggerRef = useRef(null);
  const close = (restoreFocus = true) => {
    onOpenChange(false);
    if (restoreFocus) triggerRef.current?.focus();
  };
  const swipe = useDrawerSwipe("right", close);
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      onOpenChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  return (
    <aside className={`app-menu ${open ? "is-open" : "is-closed"}`} aria-label="App menu">
      <button type="button" className="side-drawer__backdrop" aria-label="Close menu" tabIndex={open ? 0 : -1} onClick={() => close()} />
      <button
        ref={triggerRef}
        type="button"
        className="app-menu__trigger"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="app-menu-drawer"
        onClick={() => onOpenChange(!open)}
      >
        <span className="app-menu__avatar"><Icon name="user" size={24} /></span>
      </button>
      <div
        id="app-menu-drawer"
        className={`app-menu__drawer ${swipe.dragging ? "is-dragging" : ""}`}
        aria-hidden={!open}
        inert={!open}
        style={swipe.style}
        onPointerDown={swipe.onPointerDown}
        onPointerMove={swipe.onPointerMove}
        onPointerUp={swipe.onPointerUp}
        onPointerCancel={swipe.onPointerCancel}
        onClickCapture={swipe.onClickCapture}
      >
        <div className="app-menu__heading">Menu</div>
        <section className={`app-menu__volume ${volumeExpanded ? "" : "is-collapsed"}`} aria-label="Device volume">
          <div className="app-menu__volume-heading">Device volume <small>Only this device</small></div>
          <VolumeControl
            expanded={volumeExpanded}
            onExpandedChange={onVolumeExpandedChange}
            volume={volume}
            onVolumeChange={onVolumeChange}
            muted={muted}
            onMutedChange={onMutedChange}
          />
        </section>
        <nav className="app-menu__actions" aria-label="App options">
          {canAccessDatabase && (
            <button type="button" className="session-panel__action" onClick={() => { close(false); onOpenDatabase(); }}>
              <span className="session-panel__action-icon"><Icon name="archive" size={19} /></span>
              <span className="session-panel__action-copy"><strong>Database</strong><small>Manage tracks and display names</small></span>
              <Icon name="chevronRight" size={17} />
            </button>
          )}
          <button type="button" className="session-panel__action" onClick={() => { close(false); onOpenSettings(); }}>
            <span className="session-panel__action-icon"><Icon name="settings" size={19} /></span>
            <span className="session-panel__action-copy"><strong>Settings</strong><small>Playback and interface options</small></span>
            <Icon name="chevronRight" size={17} />
          </button>
        </nav>
      </div>
    </aside>
  );
}
