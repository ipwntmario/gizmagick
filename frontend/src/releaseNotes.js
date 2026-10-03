// Add each new release at the top. The former latest release then appears in Previous updates automatically.
export const RELEASE_NOTES = [
  {
    version: "0.2.1",
    intro: "Clearer playback, more expressive themes, and a smoother experience on every screen.",
    updates: [
      { title: "Find your way around", detail: "A new How it works guide explains tracks, sections, modes, and the playback flow. The Track Library opens first on mobile for quick selection." },
      { title: "Follow and shape the music", detail: "Simple tracks now show elapsed and total time and can be scrubbed. Dynamic tracks have a collapsible CLIPS area, with sections and modes ordered by how much they change the music." },
      { title: "Change your mind mid-fade", detail: "Stop can now be undone before the fade-out finishes, restoring playback instead of waiting for the track to end." },
      { title: "Make it yours", detail: "Choose Dark, Light, Signet, or Castle (Torchlit) for any session. The fantasy themes add richer textures and an optional wand-like cursor glow and sparkles." },
      { title: "Better on mobile", detail: "The Track Library and Auto-Play controls are more compact, and expanded volume makes room by temporarily collapsing the session name to its icon." },
      { title: "Focused listening roles", detail: "Observer-Member and Member stay on Play Controls on mobile with a display-only TRACK indicator. Their desktop view hides the library and centers the playback area." },
    ],
  },
  {
    version: "0.2",
    intro: "A more polished, flexible way to explore and play tracks.",
    updates: [
      { title: "A cleaner foundation", detail: "Refactored playback and interface code, refreshed the app's icons, and polished the session, settings, and database panels." },
      { title: "Steadier playback controls", detail: "Reorganized the progress, section, mode, and transport areas. Section and mode spaces now hold their size as a track changes." },
      { title: "A better track library", detail: "Added a resizable desktop panel, dedicated mobile views, quick track actions, title scrolling, and clearer track and queue indicators." },
      { title: "Queue with confidence", detail: "Tracks can preload for later playback, Auto-Play respects your choice, and pending tracks, sections, and modes can be undone." },
      { title: "Useful details", detail: "Added status history, compact volume controls, subtle queued-state highlights, and clearer behavior when ending or replacing a track." },
    ],
  },
];

export const LATEST_RELEASE = RELEASE_NOTES[0];
export const PREVIOUS_RELEASES = RELEASE_NOTES.slice(1);
// Include the notes as well as the version so edits to the latest update show again.
export const LATEST_RELEASE_SIGNATURE = JSON.stringify(LATEST_RELEASE);
