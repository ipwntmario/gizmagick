export const THEMES = [
  { id: "dark", name: "Dark", group: "Standard" },
  { id: "medium-contrast-dark", name: "Medium Contrast Dark", group: "Standard" },
  { id: "medium-contrast-dark-v1", name: "Medium Contrast Dark v1", group: "Standard", old: true },
  { id: "dark-magic-subtle", name: "Dark Magic", group: "Standard" },
  { id: "medium-contrast-dark-magic", name: "Medium Contrast Dark Magic", group: "Standard" },
  { id: "medium-contrast-dark-magic-v1", name: "Medium Contrast Dark Magic v1", group: "Standard", old: true },
  { id: "high-contrast", name: "High Contrast Dark", group: "Standard" },
  { id: "light", name: "Light", group: "Standard" },
  { id: "medium-contrast-light", name: "Medium Contrast Light", group: "Standard" },
  { id: "medium-contrast-light-v1", name: "Medium Contrast Light v1", group: "Standard", old: true },
  { id: "high-contrast-light", name: "High Contrast Light", group: "Standard" },
  { id: "dark-magic", name: "Dark Magic (Vibrant)", group: "Fun" },
  { id: "pink-splash", name: "Pink Splash", group: "Fun", cursorEffect: "wand" },
  { id: "pink-splash-original", name: "Pink Splash v1", group: "Fun", cursorEffect: "wand", old: true },
  { id: "signet", name: "Signet", group: "Fantasy", cursorEffect: "wand" },
  { id: "pink-palace", name: "Pink Palace", group: "Fantasy", cursorEffect: "wand" },
  { id: "castle-torchlit", name: "Castle", group: "Fantasy", cursorEffect: "wand" },
  { id: "h4ck3r", name: "H4ck3r", group: "Tech", cursorEffect: "terminal" },
];

export const SESSION_THEME_DEFAULTS = {
  private: "dark",
  awc: "castle-torchlit",
  "cyberspace-club": "h4ck3r",
};

export function themeSessionKey(roomId) {
  return roomId || "private";
}

export function availableThemes(enableOldThemes = false) {
  return THEMES.filter((theme) => !theme.old || enableOldThemes);
}

export function resolveTheme(roomId, requestedThemeId, enableOldThemes = false) {
  const choices = availableThemes(enableOldThemes);
  const normalizedThemeId = {
    book1: "signet",
    hogwarts: "castle-torchlit",
    "four-houses": "castle-torchlit",
  }[requestedThemeId] || requestedThemeId;
  return choices.find((theme) => theme.id === normalizedThemeId)
    || choices.find((theme) => theme.id === SESSION_THEME_DEFAULTS[themeSessionKey(roomId)])
    || choices[0];
}

export function themeStorageKey(roomId) {
  return `wizamp.theme.${themeSessionKey(roomId)}`;
}
