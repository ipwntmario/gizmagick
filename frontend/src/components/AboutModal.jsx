import { useEffect, useRef } from "react";
import Icon from "./Icon";
import { LATEST_RELEASE, PREVIOUS_RELEASES } from "../releaseNotes";

const concepts = [
  {
    number: "01",
    title: "Tracks",
    detail: "A complete piece of music. Some tracks play straight through; dynamic tracks contain sections and modes you can shape while they play.",
  },
  {
    number: "02",
    title: "Sections",
    detail: "The musical parts inside a dynamic track—such as exploration, tension, or an ending. Gizmagick only offers transitions the track supports.",
  },
  {
    number: "03",
    title: "Modes",
    detail: "Alternate versions of the current section, like a lighter or more intense arrangement. A mode changes the sound without leaving that section.",
  },
];

const flow = [
  ["Choose a track", "With no track loaded, selecting a library track starts it when ready. Add a track to the queue to keep it waiting until you press Play."],
  ["Let it play", "Gizmagick moves through short clips behind the scenes, creating a continuous performance instead of a fixed recording."],
  ["Shape what comes next", "Choose an available section or mode. Your choice is queued, then applied at the next musical transition so the change stays in time."],
  ["Continue or finish", "Queue another track, choose an ending when one is available, or let Auto-Play carry the session forward."],
];

function GuidePanel() {
  return (
    <div id="about-guide-panel" role="tabpanel" aria-labelledby="about-guide-tab" className="about-panel__body">
      <div className="about-panel__section-heading">
        <div>
          <h3>Music that follows the moment</h3>
          <p className="about-panel__intro">Gizmagick keeps music responsive without asking you to manually time every transition.</p>
        </div>
        <button type="button" className="about-panel__tutorial" disabled title="Guided tutorial coming later">
          <Icon name="wand" size={15} />
          Tutorial
          <span>Coming later</span>
        </button>
      </div>

      <div className="about-panel__concepts" aria-label="How Gizmagick music is organized">
        {concepts.map(({ number, title, detail }, index) => (
          <div className="about-panel__concept" key={title}>
            <span className="about-panel__concept-number">{number}</span>
            <strong>{title}</strong>
            <p>{detail}</p>
            {index > 0 && <Icon name="chevronRight" size={18} />}
          </div>
        ))}
      </div>

      <h4 className="about-panel__flow-title">The playback flow</h4>
      <ol className="about-panel__flow">
        {flow.map(([title, detail], index) => (
          <li key={title}>
            <span>{index + 1}</span>
            <div><strong>{title}</strong><p>{detail}</p></div>
          </li>
        ))}
      </ol>
      <p className="about-panel__tip"><Icon name="undo" size={15} />Changed your mind? Select the queued choice again, or use Undo before the transition completes.</p>
    </div>
  );
}

function UpdateList({ updates }) {
  return (
    <ul className="about-panel__updates">
      {updates.map(({ title, bullets }) => (
        <li key={title}>
          <strong>{title}</strong>
          <ul className="about-panel__update-bullets">
            {bullets.map((bullet) => <li key={bullet}><span>{bullet}</span></li>)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function UpdatesPanel() {
  return (
    <div id="about-updates-panel" role="tabpanel" aria-labelledby="about-updates-tab" className="about-panel__body">
      <h3>What’s new in v{LATEST_RELEASE.version}</h3>
      <p className="about-panel__intro">{LATEST_RELEASE.intro}</p>
      <UpdateList updates={LATEST_RELEASE.updates} />
    </div>
  );
}

function PreviousUpdatesPanel() {
  return (
    <div id="about-history-panel" role="tabpanel" aria-labelledby="about-history-tab" className="about-panel__body">
      <h3>Previous updates</h3>
      <p className="about-panel__intro">Earlier releases, newest first.</p>
      <div className="about-panel__history" aria-label="Previous release notes">
        {PREVIOUS_RELEASES.map((release) => (
          <article className="about-panel__release" key={release.version}>
            <h4>Version {release.version}</h4>
            <p className="about-panel__intro">{release.intro}</p>
            <UpdateList updates={release.updates} />
          </article>
        ))}
      </div>
    </div>
  );
}

export default function AboutModal({ open, onClose, iconSrc, section = "guide", onSectionChange }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="about-overlay" onClick={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <section className="about-panel" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <button ref={closeRef} type="button" className="about-panel__close database-icon-button" onClick={onClose} aria-label="Close About Gizmagick">
          <Icon name="close" size={20} />
        </button>
        <header className="about-panel__header">
          <img src={iconSrc} alt="" className={iconSrc?.endsWith("-white.svg") ? "about-panel__logo--monochrome" : iconSrc?.endsWith("-black.svg") ? "about-panel__logo--black" : undefined} />
          <div>
            <p className="about-panel__eyebrow">About the app</p>
            <h2 id="about-title">Gizmagick</h2>
            <span className="about-panel__version">Version {LATEST_RELEASE.version}</span>
          </div>
        </header>
        <nav className="about-panel__tabs" role="tablist" aria-label="About Gizmagick">
          <button
            id="about-guide-tab"
            type="button"
            role="tab"
            aria-selected={section === "guide"}
            aria-controls="about-guide-panel"
            className={section === "guide" ? "is-active" : ""}
            onClick={() => onSectionChange?.("guide")}
          >
            How it works
          </button>
          <button
            id="about-updates-tab"
            type="button"
            role="tab"
            aria-selected={section === "updates"}
            aria-controls="about-updates-panel"
            className={section === "updates" ? "is-active" : ""}
            onClick={() => onSectionChange?.("updates")}
          >
            Latest update
          </button>
          <button
            id="about-history-tab"
            type="button"
            role="tab"
            aria-selected={section === "history"}
            aria-controls="about-history-panel"
            className={section === "history" ? "is-active" : ""}
            onClick={() => onSectionChange?.("history")}
          >
            Previous updates
          </button>
        </nav>
        {section === "updates" ? <UpdatesPanel /> : section === "history" ? <PreviousUpdatesPanel /> : <GuidePanel />}
      </section>
    </div>
  );
}
