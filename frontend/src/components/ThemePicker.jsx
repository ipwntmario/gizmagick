import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { availableThemes } from "../themes";
import CursorEffect from "./CursorEffect";
import Icon from "./Icon";

function ThemePreview({ theme }) {
  const screenRef = useRef(null);
  return (
    <div className="theme-preview" data-theme={theme.id}>
      <div className="theme-preview__window-header">
        <span className="theme-preview__window-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>Gizmagick / {theme.name}</span>
        <small>LIVE PREVIEW</small>
      </div>
      <div ref={screenRef} className="theme-preview__screen" role="img" aria-label={`${theme.name} theme preview with track library, playback controls, sections, modes, and progress`}>
        <div className="theme-preview__topbar">
          <span className="theme-preview__room"><Icon name="door" size={16} /> Session</span>
          <span className="theme-preview__device"><Icon name="volume" size={16} /> 72%</span>
        </div>
        <div className="theme-preview__content">
          <div className="theme-preview__library">
            <div className="theme-preview__label"><Icon name="library" size={15} /> TRACK LIBRARY</div>
            <div className="theme-preview__filter"><Icon name="filter" size={13} /> Filters</div>
            <div className="theme-preview__track is-current"><span>Signal Drift<small>DYNAMIC</small></span><Icon name="moreVertical" size={15} /></div>
            <div className="theme-preview__track"><span>A Hearth of Mysteries</span><Icon name="moreVertical" size={15} /></div>
            <div className="theme-preview__track"><span>Night Frequency</span><Icon name="moreVertical" size={15} /></div>
          </div>
          <div className="theme-preview__player">
            <div className="theme-preview__track-title">Signal Drift <span>NOW PLAYING</span></div>
            <div className="theme-preview__clips">
              <div className="theme-preview__group-label">CLIPS <Icon name="chevronDown" size={13} /></div>
              <div className="theme-preview__clip-time"><span>1:20</span><span>2:00</span></div>
              <div className="theme-preview__clip-bar"><span /></div>
            </div>
            <div className="theme-preview__section-group">
              <div className="theme-preview__group-label">MODES</div>
              <div className="theme-preview__button-row">
                <span className="theme-preview__mode is-active">Base</span>
                <span className="theme-preview__mode">Pulse</span>
                <span className="theme-preview__mode">Ambient</span>
              </div>
            </div>
            <div className="theme-preview__section-group">
              <div className="theme-preview__group-label theme-preview__group-label--sections">SECTIONS <span>Main</span></div>
              <div className="theme-preview__button-row">
                <span className="theme-preview__section">Bridge</span>
                <span className="theme-preview__section is-end">Ending</span>
              </div>
            </div>
            <div className="theme-preview__transport">
              <span className="theme-preview__autoplay"><Icon name="play" size={11} /></span>
              <span className="theme-preview__transport-button is-undo"><Icon name="undo" size={16} /></span>
              <span className="theme-preview__transport-button is-play"><Icon name="pause" size={19} /></span>
              <span className="theme-preview__transport-button is-stop"><Icon name="stop" size={15} /></span>
              <span className="theme-preview__volume"><Icon name="volume" size={18} /></span>
            </div>
            <div className="theme-preview__indicator"><strong>TRACK</strong><span>Signal Drift</span><Icon name="chevronUp" size={15} /></div>
          </div>
        </div>
        <div className="theme-preview__status"><span className="theme-preview__pulse" /> STATUS <strong>Playing: Signal Drift</strong></div>
        <CursorEffect enabled effect={theme.cursorEffect} themeId={theme.id} containerRef={screenRef} />
      </div>
    </div>
  );
}

export default function ThemePicker({ room, initialThemeId, enableOldThemes = false, onCancel, onApply }) {
  const themes = availableThemes(enableOldThemes);
  const [selectedId, setSelectedId] = useState(initialThemeId);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const dialogRef = useRef(null);
  const mobileMenuRef = useRef(null);
  const mobileTriggerRef = useRef(null);
  const onCancelRef = useRef(onCancel);
  const selectedTheme = themes.find(({ id }) => id === selectedId) || themes[0];
  const groups = [...new Set(themes.map(({ group }) => group))];
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    mobileMenuRef.current?.querySelector('[aria-pressed="true"]')?.focus();
    const onPointerDown = (event) => {
      if (!mobileMenuRef.current?.contains(event.target)) setMobileMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [mobileMenuOpen]);
  useEffect(() => {
    const focusToRestore = document.activeElement;
    const isVisible = (element) => element.getClientRects().length > 0;
    [...dialogRef.current.querySelectorAll('button[aria-pressed="true"], [data-theme-picker-trigger]')]
      .find(isVisible)?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancelRef.current();
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialogRef.current.querySelectorAll("button:not(:disabled), select:not(:disabled)")]
        .filter(isVisible);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      focusToRestore?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="theme-picker-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section ref={dialogRef} className="theme-picker" role="dialog" aria-modal="true" aria-labelledby="theme-picker-title">
        <header className="theme-picker__header">
          <div><span className="theme-picker__eyebrow">SESSION APPEARANCE</span><h2 id="theme-picker-title">Theme for {room.name}</h2></div>
          <button type="button" className="theme-picker__close" onClick={onCancel} aria-label="Cancel theme selection"><Icon name="close" size={20} /></button>
        </header>
        <div className="theme-picker__body">
          <nav className="theme-picker__choices" aria-label="Themes">
            {groups.map((group) => (
              <div className="theme-picker__group" key={group}>
                <h3>{group}</h3>
                <div className="theme-picker__group-options">
                  {themes.filter((theme) => theme.group === group).map((theme) => (
                    <button key={theme.id} type="button" className={`theme-picker__choice ${selectedId === theme.id ? "is-selected" : ""}`} aria-pressed={selectedId === theme.id} onClick={() => setSelectedId(theme.id)}>
                      <span className={`session-theme-picker__swatch session-theme-picker__swatch--${theme.id}`} aria-hidden="true" />
                      <span>{theme.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <ThemePreview theme={selectedTheme} />
          <div className="theme-picker__mobile-controls" onKeyDown={(event) => {
            if (!mobileMenuOpen) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setMobileMenuOpen(false);
              mobileTriggerRef.current?.focus();
              return;
            }
            const options = [...(mobileMenuRef.current?.querySelectorAll(".theme-picker__mobile-option") || [])];
            const currentIndex = options.indexOf(event.target);
            if (currentIndex < 0) return;
            const nextIndex = event.key === "ArrowDown" ? (currentIndex + 1) % options.length
              : event.key === "ArrowUp" ? (currentIndex - 1 + options.length) % options.length
                : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
            if (nextIndex >= 0) { event.preventDefault(); options[nextIndex].focus(); }
          }}>
            <span className="theme-picker__mobile-label">Theme</span>
            <div className="theme-picker__mobile-menu" ref={mobileMenuRef} onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setMobileMenuOpen(false);
            }}>
              <button
                ref={mobileTriggerRef}
                type="button"
                className="theme-picker__mobile-trigger"
                data-theme-picker-trigger
                aria-label={`Choose theme, ${selectedTheme.name}`}
                aria-expanded={mobileMenuOpen}
                aria-controls={mobileMenuOpen ? "theme-picker-mobile-options" : undefined}
                onClick={() => setMobileMenuOpen((open) => !open)}
              >
                <span className={`session-theme-picker__swatch session-theme-picker__swatch--${selectedTheme.id}`} aria-hidden="true" />
                <span>{selectedTheme.name}</span>
                <Icon name="chevronDown" size={17} />
              </button>
              {mobileMenuOpen && (
                <div className="theme-picker__mobile-options" id="theme-picker-mobile-options" aria-label="Themes">
                  {groups.map((group) => (
                    <div className="theme-picker__mobile-group" key={group}>
                      <h3>{group}</h3>
                      {themes.filter((theme) => theme.group === group).map((theme) => (
                        <button
                          key={theme.id}
                          type="button"
                          className={`theme-picker__mobile-option ${selectedId === theme.id ? "is-selected" : ""}`}
                          aria-pressed={selectedId === theme.id}
                          onClick={() => {
                            setSelectedId(theme.id);
                            setMobileMenuOpen(false);
                            mobileTriggerRef.current?.focus();
                          }}
                        >
                          <span className={`session-theme-picker__swatch session-theme-picker__swatch--${theme.id}`} aria-hidden="true" />
                          <span>{theme.name}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <footer className="theme-picker__footer">
          <span>Selection affects this session when you choose OK.</span>
          <div><button type="button" className="theme-picker__cancel" onClick={onCancel}>Cancel</button><button type="button" className="theme-picker__confirm" onClick={() => onApply(selectedTheme.id)}>OK</button></div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
