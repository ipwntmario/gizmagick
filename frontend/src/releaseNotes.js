// Add each new release at the top. The former latest release then appears in Previous updates automatically.
export const RELEASE_NOTES = [
  {
    version: "0.2.2",
    intro: "Gizmagick's new name and logo, more themes, easier track browsing, and improved session controls.",
    updates: [
      { title: "Gizmagick name and logo", bullets: ["Wizamp is now Gizmagick, with a new full-color logo.", "Black and white logo variants are available for monochrome use."] },
      { title: "New themes and theme previews", bullets: ["High Contrast Dark and High Contrast Light offer flat surfaces and clearer controls.", "H4ck3r adds a terminal look and green ASCII characters around the cursor.", "Preview themes in a separate picker before applying or canceling. Castle has a shorter name, and Signet has smoother surfaces."] },
      { title: "Track search and filters", bullets: ["Search by title with fuzzy matching. The search field expands while you type.", "Matching tracks outside your filters appear in a separate results group.", "Library filters are saved. Database filters apply only there and reset each time it opens."] },
      { title: "Track durations and sorting", bullets: ["See durations beside track titles. Dynamic tracks show an italicized ∑ total for all clips and mode variants, measured to their loop points.", "Click Title or the clock header to sort in either direction. Your choice is saved."] },
      { title: "Track playback and Auto-Play", bullets: ["With no track loaded, selecting a track starts it regardless of Auto-Play. Press Play to start the first queued track instead.", "Track menus offer Play or Load after ending/stopping the current track, or after stopping it directly.", "Auto-Play is an icon toggle beside the track indicator. Desktop track volume stays visible when no track is loaded."] },
      { title: "Quick Stop and keyboard Undo", bullets: ["Hold Stop, or press it during a normal stop fade, to shorten the fade. Fades over one second become 0.5 seconds; shorter fades are halved.", "Press Stop again during the quick fade to keep the next track from playing. Auto-Play pulses and locks temporarily, then returns to its prior setting.", "Use Ctrl+Z whenever Undo is available."] },
      { title: "Mobile action sheets", bullets: ["Long-press a library or database track to open its actions. Kebab buttons open the same sheet.", "Track actions, database actions, and rename dialogs slide up from the bottom. Drag down or tap outside to dismiss.", "Long-pressing track titles avoids text selection and accidental playback."] },
      { title: "Sessions and app menu", bullets: ["Sessions slide in from the left. A separate app menu slides in from the right with main volume, Database, and Settings.", "Main volume opens expanded and remembers whether you collapse it.", "Cyberspace Club uses H4ck3r by default. Private Session stays last, separated from online sessions."] },
      { title: "Session users", bullets: ["Online session indicators show a people count and brief join/leave messages. Tap the count to see users, or pin the panel open.", "Changing a display name updates the same user without showing a leave and join.", "Roles are now Director, Observer-Member, and Member. Loading and readiness text appears only when relevant."] },
      { title: "Online playback and audio access", bullets: ["Switching sessions immediately clears the previous session's playback and catches up to the new session's track.", "Switching sessions or closing the welcome panel can enable audio and start catch-up without another Enable audio click.", "The Enable audio prompt has a refreshed appearance when the browser still requires it."] },
      { title: "Settings and update notes", bullets: ["Latency is hidden by default; enable it under Settings → Interface. Clock offset has a separate toggle under Developer.", "The welcome panel stops appearing after you view the latest update and returns when those notes change.", "Update notes now use feature headings and short bullet points. Panels, controls, and theme previews have received layout and contrast fixes."] },
      { title: "Local testing through ngrok", bullets: ["A single ngrok tunnel can now serve the local app and its Worker connection.", "The README includes the local Worker and ngrok setup."] },
    ],
  },
  {
    version: "0.2.1",
    intro: "New help, playback controls, themes, and mobile improvements.",
    updates: [
      { title: "How it works guide", bullets: ["Learn how tracks, sections, modes, and playback work.", "Open the guide from the welcome panel."] },
      { title: "Track progress and clips", bullets: ["Simple tracks show elapsed time and total duration. Drag the progress bar to seek.", "Collapse or expand the Clips area for dynamic tracks.", "Playback controls appear in order: Clips, Modes, then Sections."] },
      { title: "Undo Stop", bullets: ["Undo a Stop while its fade-out is still running to restore playback."] },
      { title: "Session themes", bullets: ["Choose Dark, Light, Signet, or Castle for each session.", "Fantasy themes include optional cursor glow and sparkles."] },
      { title: "Mobile layout", bullets: ["The Track Library opens first for quick track selection.", "Track Library and Auto-Play controls take up less space.", "Expanding volume temporarily reduces the session indicator to its icon."] },
      { title: "Member and Observer-Member views", bullets: ["On mobile, these roles stay on Play Controls with a display-only track indicator.", "On desktop, the track library is hidden and playback controls are centered."] },
    ],
  },
  {
    version: "0.2",
    intro: "Updated panels, track browsing, queueing, and playback controls.",
    updates: [
      { title: "Updated panels and icons", bullets: ["Refreshed app icons and the Sessions, Settings, and Database panels.", "Reorganized playback and interface code."] },
      { title: "Playback layout", bullets: ["Reorganized progress, section, mode, and transport controls.", "Section and mode areas keep their size when the track changes."] },
      { title: "Track library", bullets: ["Resize the library panel on desktop or use dedicated views on mobile.", "Use quick track actions and scrolling titles.", "See clearer playing and queued track indicators."] },
      { title: "Queueing and Auto-Play", bullets: ["Queued tracks preload for later playback.", "Auto-Play follows your selected setting.", "Undo pending track, section, and mode changes."] },
      { title: "Status and volume controls", bullets: ["Review playback and loading messages in status history.", "Use compact volume controls and see highlights on queued items.", "Clearer behavior when ending or replacing a track."] },
    ],
  },
];

export const LATEST_RELEASE = RELEASE_NOTES[0];
export const PREVIOUS_RELEASES = RELEASE_NOTES.slice(1);
// Include the notes as well as the version so edits to the latest update show again.
export const LATEST_RELEASE_SIGNATURE = JSON.stringify(LATEST_RELEASE);
