import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { LATEST_RELEASE } from "../releaseNotes";
import { LOGO_VARIANTS, resolveLogo } from "../logos";

export default function SettingsModal({
  open,
  onClose,
  fadeOutSeconds, setFadeOutSeconds,
  pauseFadeSeconds, setPauseFadeSeconds,
  showStatus, setShowStatus,
  showClockOffset, setShowClockOffset,
  showLatency, setShowLatency,
  cursorEffectEnabled, setCursorEffectEnabled,
  enableOldThemes, setEnableOldThemes,
  showPlayControlsButton, setShowPlayControlsButton,
  logoVariant, setLogoVariant,
  onOpenAbout,
}) {
  const overlayRef = useRef(null);
  const mouseDownOnOverlay = useRef(false);
  const titleTapCount = useRef(0);
  const titleTapResetTimer = useRef(null);
  const [developerUnlocked, setDeveloperUnlocked] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      titleTapCount.current = 0;
      clearTimeout(titleTapResetTimer.current);
    }
    return () => clearTimeout(titleTapResetTimer.current);
  }, [open]);

  function handleTitleTap() {
    clearTimeout(titleTapResetTimer.current);
    titleTapCount.current += 1;
    if (titleTapCount.current >= 5) {
      titleTapCount.current = 0;
      setDeveloperUnlocked(true);
      return;
    }
    titleTapResetTimer.current = setTimeout(() => { titleTapCount.current = 0; }, 2200);
  }

  function setClampedNumber(rawValue, setter) {
    const value = Number(rawValue);
    if (Number.isFinite(value)) setter?.(Math.max(0, Math.min(30, value)));
  }

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      className="settings-overlay"
      onMouseDown={(event) => { mouseDownOnOverlay.current = event.target === overlayRef.current; }}
      onMouseUp={(event) => {
        if (event.target === overlayRef.current && mouseDownOnOverlay.current) onClose?.();
        mouseDownOnOverlay.current = false;
      }}
      aria-modal="true"
      aria-labelledby="settings-title"
      role="dialog"
    >
      <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
        <header className="settings-modal__header">
          <div>
            <h2 id="settings-title"><button type="button" className="settings-modal__title-trigger" onClick={handleTitleTap}>Settings</button></h2>
            <p>Personalize playback and the listening interface</p>
          </div>
          <button className="database-icon-button" onClick={onClose} aria-label="Close settings">
            <Icon name="close" size={20} />
          </button>
        </header>

        <div className="settings-modal__body">
          <section className="settings-group">
            <div className="settings-group__heading">
              <span className="settings-group__icon"><Icon name="mixer" size={18} /></span>
              <div>
                <h3>Playback</h3>
                <p>Control how audio transitions behave.</p>
              </div>
            </div>

            <label className="settings-field">
              <span className="settings-field__copy">
                <strong>Fade-out on Stop</strong>
                <small>0 is instantaneous; maximum 30 seconds.</small>
              </span>
              <span className="settings-number">
                <input
                  type="number" min={0} max={30} step={0.1}
                  value={fadeOutSeconds}
                  onChange={(event) => setClampedNumber(event.target.value, setFadeOutSeconds)}
                  aria-label="Fade-out on Stop in seconds"
                />
                <span>sec</span>
              </span>
            </label>

            <label className="settings-field">
              <span className="settings-field__copy">
                <strong>Pause fade</strong>
                <small>Length of the fade when playback is paused.</small>
              </span>
              <span className="settings-number">
                <input
                  type="number" min={0} max={30} step={0.1}
                  value={pauseFadeSeconds}
                  onChange={(event) => setClampedNumber(event.target.value, setPauseFadeSeconds)}
                  aria-label="Pause fade in seconds"
                />
                <span>sec</span>
              </span>
            </label>
          </section>

          <section className="settings-group">
            <div className="settings-group__heading">
              <span className="settings-group__icon"><Icon name="eye" size={18} /></span>
              <div>
                <h3>Interface</h3>
                <p>Choose what appears while you listen.</p>
              </div>
            </div>

            <label className="settings-field settings-field--toggle">
              <span className="settings-field__copy">
                <strong>Cursor effect</strong>
                <small>Show theme-specific cursor effects in Signet, Castle (Torchlit), and H4ck3r. Respects reduced-motion preferences.</small>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={!!cursorEffectEnabled}
                  onChange={(event) => setCursorEffectEnabled?.(event.target.checked)}
                />
                <span aria-hidden="true" />
              </span>
            </label>
            <label className="settings-field settings-field--toggle">
              <span className="settings-field__copy">
                <strong>Show latency</strong>
              </span>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={!!showLatency}
                  onChange={(event) => setShowLatency?.(event.target.checked)}
                />
                <span aria-hidden="true" />
              </span>
            </label>
          </section>
          {developerUnlocked && (
            <section className="settings-group">
              <div className="settings-group__heading">
                <span className="settings-group__icon"><Icon name="code" size={18} /></span>
                <div>
                  <h3>Developer</h3>
                  <p>Experimental interface options.</p>
                </div>
              </div>

              <label className="settings-field settings-field--toggle">
                <span className="settings-field__copy">
                  <strong>Enable old themes</strong>
                  <small>Include saved v1 themes in the theme picker. Saved on this device.</small>
                </span>
                <span className="toggle-switch">
                  <input type="checkbox" checked={!!enableOldThemes} onChange={(event) => setEnableOldThemes?.(event.target.checked)} />
                  <span aria-hidden="true" />
                </span>
              </label>

              <label className="settings-field settings-field--toggle">
                <span className="settings-field__copy">
                  <strong>Show Play Controls button on mobile</strong>
                  <small>Show a separate Play Controls tab on mobile.</small>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!showPlayControlsButton}
                    onChange={(event) => setShowPlayControlsButton?.(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
              <label className="settings-field settings-field--toggle">
                <span className="settings-field__copy">
                  <strong>Show status bar</strong>
                  <small>Display the current loading and playback state.</small>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!showStatus}
                    onChange={(event) => setShowStatus?.(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
              <label className="settings-field settings-field--toggle">
                <span className="settings-field__copy">
                  <strong>Show clock offset</strong>
                  <small>Show the room clock offset in the users panel.</small>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={!!showClockOffset}
                    onChange={(event) => setShowClockOffset?.(event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
              <label className="settings-field settings-field--logo">
                <span className="settings-field__copy">
                  <strong>App logo</strong>
                  <small>Preview a logo for About and the browser icons. Saved on this device.</small>
                </span>
                <span className="settings-logo-picker">
                  <img
                    src={resolveLogo(logoVariant).src}
                    alt="Selected logo preview"
                    className={logoVariant === "black" ? "settings-logo-picker__preview is-black" : "settings-logo-picker__preview"}
                  />
                  <select aria-label="App logo" value={logoVariant} onChange={(event) => setLogoVariant?.(event.target.value)}>
                    {LOGO_VARIANTS.map((logo) => <option key={logo.id} value={logo.id}>{logo.label}</option>)}
                  </select>
                </span>
              </label>
            </section>
          )}
          <button type="button" className="settings-about-link" onClick={onOpenAbout}>
            <span className="settings-group__icon"><Icon name="info" size={18} /></span>
            <span className="settings-about-link__copy">
              <strong>About Gizmagick</strong>
              <small>How Gizmagick works and what’s new in Version {LATEST_RELEASE.version}</small>
            </span>
            <Icon name="chevronRight" size={18} />
          </button>
        </div>
      </section>
    </div>
  );
}
