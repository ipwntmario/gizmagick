/**
 * Wizamp
 * A Dynamic Music Web Application
 *
 * Note: The majority of this code was written by ChatGPT (models 4o and 5), but the overall function and design was
 * handled by me, Dylan Travers. It is first and foremost a personal project created out of the desire for such a thing
 * to exist, and to be used for an ongoing TTRPG group that I am a part of and write music for. I've searched high and
 * low and couldn't find any form of dynamic music engine, or at least any that I could use my own music with. Thus, I
 * figured, if it doesn't exist, I should make it exist.
 *
 * Because it's AI assisted, I don't claim for any code within this project to demonstrate my own raw coding abilities.
 * However, if it is to be assessed in any way, I can make the claim that it demontrates my ability to concieve of a
 * useful applciation, my ability to communicate goals, and work with others until those goals are achieved. My
 * attention to detail should be evident, as well as my careful consideration of what features to work on when in order
 * for adequate testing to be done.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback  } from "react";
import { AudioEngine } from "./audio/audioEngine";
import { useMusicData } from "./data/useMusicData";
import { normalizeTrackFilters } from "./data/trackOrdering";
import { findSelectableEndSection, getAutoLockedTargets } from "./data/sectionTransitions";
import { replacementRemainingSeconds } from "./data/replacementTiming";
import { useSession } from "./net/useSession";
import { resolveTheme, themeSessionKey, themeStorageKey } from "./themes";
import { useRoom } from "./net/useRoom";
import LeftPanel from "./components/LeftPanel";
import AppMenu from "./components/AppMenu";
import DatabaseModal from "./components/DatabaseModal";
import SettingsModal from "./components/SettingsModal";
import AboutModal from "./components/AboutModal";
import Icon from "./components/Icon";
import TrackList from "./components/TrackList";
import QueueIndicator from "./components/QueueIndicator";
import SectionPanel from "./components/SectionPanel";
import Transport from "./components/Transport";
import StatusBar from "./components/StatusBar";
import TrackVolumeControl from "./components/TrackVolumeControl";
import AutoplayButton from "./components/AutoplayButton";
import PrimaryPlaybackButton from "./components/PrimaryPlaybackButton";
import ClipProgress from "./components/ClipProgress";
import DynamicClipPanel from "./components/DynamicClipPanel";
import CursorEffect from "./components/CursorEffect";
import icon1Url from "./assets/icons/icon1.png";
import icon2bUrl from "./assets/icons/icon2b.png";

export default function App() {
  const { tracks, loading, error: dataError } = useMusicData();  // <- only rely on tracks here
  const [clips, setClips] = useState({});
  const [sections, setSections] = useState({});

  const [useAlternateIcon, setUseAlternateIcon] = useState(() => {
    try { return localStorage.getItem("wizamp_useAlternateIcon") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_useAlternateIcon", useAlternateIcon ? "1" : "0"); } catch {}
  }, [useAlternateIcon]);
  const [showAbout, setShowAbout] = useState(true);
  const [aboutSection, setAboutSection] = useState(() => {
    try {
      const hasSeenGuide = localStorage.getItem("wizamp_hasSeenGuide") === "1";
      localStorage.setItem("wizamp_hasSeenGuide", "1");
      return hasSeenGuide ? "updates" : "guide";
    } catch {
      return "guide";
    }
  });
  const [libraryExpanded, setLibraryExpanded] = useState(true);
  const [libraryWidth, setLibraryWidth] = useState(300);
  const [resizingLibrary, setResizingLibrary] = useState(false);
  const libraryResizePointer = useRef(null);
  const [mobileView, setMobileView] = useState("library");
  const [dynamicClipsExpanded, setDynamicClipsExpanded] = useState(() => {
    try { return localStorage.getItem("wizamp_dynamicClipsExpanded") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_dynamicClipsExpanded", dynamicClipsExpanded ? "1" : "0"); } catch {}
  }, [dynamicClipsExpanded]);

  const [status, setStatus] = useState("Idle");
  const [statusHistory, setStatusHistory] = useState([]);
  const [selectedTrack, setSelectedTrack] = useState(null);
  const [playingTrackName, setPlayingTrackName] = useState(null);
  const [isLoadingTrack, setIsLoadingTrack] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // Section state used by the UI
  const [currentSectionName, setCurrentSectionName] = useState(null);
  const [queuedSectionName, setQueuedSectionName] = useState(null);

  // derive playing state
  const isPlaying = /^Playing/.test(status);
  const isPaused = status === "Paused";
  const isActive = isPlaying || isPaused;

  // Mirrors of state for engine callbacks (avoid stale closures)
  const selectedTrackRef = useRef(null);
  const playingTrackNameRef = useRef(null);
  const autoplayRef = useRef(true);
  const isActiveRoleRef = useRef(true);
  const roomRef = useRef(null);
  const loadBusyRef = useRef(false);
  const failedLoadRef = useRef(null);

  // Mirrors of state for net callbacks

  // After late-join hydrate, ignore any queued sections/modes from room STATE for a moment
  const ignoreQueueUntilMsRef = useRef(0);
  const setHydrateGuard = useCallback((ms=3000) => { ignoreQueueUntilMsRef.current = Date.now() + ms; }, []);
  const shouldIgnoreQueues = useCallback(() => Date.now() < (ignoreQueueUntilMsRef.current || 0), []);

  // Autoplay setting (persist)
  const [autoplay, setAutoplay] = useState(() => {
    try {
      const stored = localStorage.getItem("wizamp_autoplay");
      return stored == null ? true : stored === "1";
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_autoplay", autoplay ? "1" : "0"); } catch {}
  }, [autoplay]);

  const [playRequestedFor, setPlayRequestedFor] = useState(null);
  const [queuedTrack, setQueuedTrack] = useState(null);
  // null follows Auto-Play; a boolean records an explicit library Play or Load choice.
  const queuedTrackPlayAfterReleaseRef = useRef(null);
  const [queuedTrackProgress, setQueuedTrackProgress] = useState(null);
  const queuedTrackTimingRef = useRef(null);
  const [queuedChoiceProgress, setQueuedChoiceProgress] = useState({ section: null, mode: null });
  const queuedChoiceTimingRef = useRef({ section: null, mode: null });
  const queuedTrackRef = useRef(null);
  const [replacementPending, setReplacementPending] = useState(false);
  const replacementPendingRef = useRef(false);
  const setReplacementInProgress = useCallback((pending) => {
    replacementPendingRef.current = pending;
    setReplacementPending(pending);
  }, []);
  const [releasedQueuedTrack, setReleasedQueuedTrack] = useState(null);
  const preparedTracksRef = useRef(new Map());
  const trackAssetPromisesRef = useRef(new Map());

  // Auto-start for late joiners
  const pendingPlayRef = useRef(null); // { trackName, sectionName, serverMs } or null

  const sendSyncResponseRef = useRef(null);

  // Status visibility (persist)
  const [showStatus, setShowStatus] = useState(() => {
    try { return localStorage.getItem("wizamp_showStatus") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_showStatus", showStatus ? "1" : "0"); } catch {}
  }, [showStatus]);
  const [cursorEffectEnabled, setCursorEffectEnabled] = useState(() => {
    try { return localStorage.getItem("wizamp_cursorEffect") !== "0"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_cursorEffect", cursorEffectEnabled ? "1" : "0"); } catch {}
  }, [cursorEffectEnabled]);
  const [showPlayControlsButton, setShowPlayControlsButton] = useState(() => {
    try {
      const stored = localStorage.getItem("wizamp_showPlayControlsButton");
      return stored == null ? true : stored === "1";
    } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_showPlayControlsButton", showPlayControlsButton ? "1" : "0"); } catch {}
  }, [showPlayControlsButton]);

  const { roomId, setRoomId, onlineEnabled, role, setRole, displayName, setDisplayName, roomIdentities, setRoomIdentity } = useSession();
  const [themeChoices, setThemeChoices] = useState({});
  const roomThemeKey = themeSessionKey(roomId);
  let savedThemeId;
  try { savedThemeId = localStorage.getItem(themeStorageKey(roomId)); } catch { /* Storage may be disabled. */ }
  const activeTheme = resolveTheme(roomId, themeChoices[roomThemeKey] ?? savedThemeId);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = activeTheme.id;
  }, [activeTheme.id]);
  const chooseTheme = (targetRoomId, themeId) => {
    if (resolveTheme(targetRoomId, themeId).id !== themeId) return;
    setThemeChoices((previous) => ({ ...previous, [themeSessionKey(targetRoomId)]: themeId }));
    try { localStorage.setItem(themeStorageKey(targetRoomId), themeId); } catch { /* Storage may be disabled. */ }
  };
  const isActiveRole = !onlineEnabled || role === "GM";
  const isPassiveRole = onlineEnabled && role === "PASSIVE";
  const isReadOnlyRole = onlineEnabled && (role === "PASSIVE" || role === "PASSIVE_BTS");
  const effectiveMobileView = isReadOnlyRole ? "controls" : mobileView;

  // Audio unlock for Chrome late-joiners
  const [audioLocked, setAudioLocked] = useState(false);

  // Track if a net "start" arrived while audio was locked, so we can resync after unlock
  const [pendingNetStart, setPendingNetStart] = useState(null); // or useRef(null)

  // Modes
  const [currentModeName, setCurrentModeName] = useState("base");
  const [queuedModeName, setQueuedModeName] = useState(null);
  const queuedSectionRef = useRef(null);
  const queuedModeRef = useRef(null);

  // Session-only undo history for pending queue changes.
  const [undoHistory, setUndoHistory] = useState([]);
  const undoHistoryRef = useRef([]);
  const [undoEffect, setUndoEffect] = useState(null);
  const undoEffectTimerRef = useRef(null);
  const updateUndoHistory = useCallback((updater) => {
    const next = typeof updater === "function" ? updater(undoHistoryRef.current) : updater;
    undoHistoryRef.current = next;
    setUndoHistory(next);
  }, []);
  const dropUndoActions = useCallback((kind) => {
    updateUndoHistory(previous => previous.filter(action => action.kind !== kind));
  }, [updateUndoHistory]);
  const dropUndoActionsMatching = useCallback((predicate) => {
    updateUndoHistory(previous => previous.filter(action => !predicate(action)));
  }, [updateUndoHistory]);

  // Users panel

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fadeOutSeconds, setFadeOutSeconds] = useState(6); // default 4
  const [pauseFadeSeconds, setPauseFadeSeconds] = useState(() => {
    try { return Number(localStorage.getItem("wizamp_pauseFade")) || 1; } catch { return 1; }
  });

  // Database modal
  const [dbOpen, setDbOpen] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState(() => {
    try { return localStorage.getItem("ui.panelOpen") === "true" ? "sessions" : null; }
    catch { return null; }
  });
  useEffect(() => {
    try { localStorage.setItem("ui.panelOpen", String(activeDrawer === "sessions")); }
    catch { /* Storage may be disabled. */ }
  }, [activeDrawer]);

  // App.jsx (top-level state)
  const [dbSort, setDbSort] = useState(() => localStorage.getItem("wizamp_dbSort") || "alpha-asc");
  const [librarySort, setLibrarySort] = useState(() => {
    try { return localStorage.getItem("wizamp_librarySort") === "alpha-desc" ? "alpha-desc" : "alpha-asc"; }
    catch { return "alpha-asc"; }
  });
  const [libraryFilters, setLibraryFilters] = useState(() => {
    try {
      const saved = localStorage.getItem("wizamp_libraryFilters");
      return normalizeTrackFilters(saved ? JSON.parse(saved) : undefined);
    } catch { return normalizeTrackFilters(); }
  });

  // Pinned tracks (persisted as array of names)
  const [pinned, setPinned] = useState(() => {
    try {
      const raw = localStorage.getItem("wizamp_pinned");
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  });

  const togglePin = (name) => {
    setPinned(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };


  const [clipProgress, setClipProgress] = useState(0);  // 0..1 visual bar
  const [clipPositionSeconds, setClipPositionSeconds] = useState(0);
  const [clipDurationSeconds, setClipDurationSeconds] = useState(0);

  // Volume settings
  const [trackVolUIOpen, setTrackVolUIOpen] = useState(false);
  const [trackVolume, setTrackVolume] = useState(1); // 0..1
  const [userVolume, setUserVolume] = useState(1);   // 0..1 (local)
  const [userMuted, setUserMuted] = useState(false);
  const [userVolumeOpen, setUserVolumeOpen] = useState(() => {
    try { return localStorage.getItem("wizamp_menuVolumeExpanded") !== "false"; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_menuVolumeExpanded", String(userVolumeOpen)); }
    catch { /* Storage may be disabled. */ }
  }, [userVolumeOpen]);

  const displayedStatus = loading ? "Loading data…" : dataError || status;
  useEffect(() => {
    setStatusHistory(previous => {
      if (previous.at(-1)?.text === displayedStatus) return previous;
      return [...previous, {
        id: `${Date.now()}-${previous.length}`,
        text: displayedStatus,
        timestamp: Date.now(),
      }];
    });
  }, [displayedStatus]);

  // Rename registry (persisted)
  // Shape:
  // names = {
  //   tracks:   { [trackName]: { displayName?: string } },
  //   sections: { [trackName]: { [sectionKey]: { displayName?: string, buttonName?: string, baseModeName?: string } } },
  //   modes:    { [trackName]: { [sectionKey]: { [modeName]: { displayName?: string } } } }
  //   // base mode uses key "__base__" in modes OR sections.baseModeName
  // }
  const [names, setNames] = useState(() => {
    try {
      const raw = localStorage.getItem("wizamp_names");
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("wizamp_names", JSON.stringify(names)); } catch {}
  }, [names]);

  // Helpers to read effective labels with overrides
  const getTrackTitle = (trackName) => {
    return names?.tracks?.[trackName]?.displayName
        ?? tracks?.[trackName]?.defaultDisplayName
        ?? trackName;
  };

  const getSectionTitle = (trackName, sectionKey) => {
    return names?.sections?.[trackName]?.[sectionKey]?.displayName
        ?? sections?.[sectionKey]?.defaultDisplayName
        ?? sectionKey;
  };

  const getSectionButton = (trackName, sectionKey) => {
    // order: explicit button override → defaultButtonName → effective section title (renames) → key
    const overrideBtn = names?.sections?.[trackName]?.[sectionKey]?.buttonName;
    if (overrideBtn != null && overrideBtn !== "") return overrideBtn;
    const s = sections?.[sectionKey];
    if (s?.defaultButtonName) return s.defaultButtonName;
    // fall back to the *renamed* section title if present
    return getSectionTitle(trackName, sectionKey) ?? sectionKey;
  };

  const getBaseModeName = (trackName, sectionKey) => {
    return names?.sections?.[trackName]?.[sectionKey]?.baseModeName
        ?? sections?.[sectionKey]?.defaultBaseModeName
        ?? "base";
  };

  const getModeLabel = (trackName, sectionKey, modeName) => {
    if (modeName === "__base__") return getBaseModeName(trackName, sectionKey);
    return names?.modes?.[trackName]?.[sectionKey]?.[modeName]?.displayName
        ?? modeName;
  };

  // Create engine once
  const engineRef = useRef(null);
  if (!engineRef.current) {
    engineRef.current = new AudioEngine({
      onStatus: async (s) => {
        console.log("[STATUS]", s);
        setStatus(s);
        if (s === "Stopped") {
          dropUndoActions("stop");
          setReplacementInProgress(false);
          setClipProgress(0);

          const playing = playingTrackNameRef.current;
          console.log("[STOP] was playing:", playing);
          setPlayingTrackName(null);
          setPlayRequestedFor(null);

          const queued = queuedTrackRef.current;
          if (queued) {
            const playAfterRelease = queuedTrackPlayAfterReleaseRef.current ?? autoplayRef.current;
            queuedTrackRef.current = null;
            queuedTrackPlayAfterReleaseRef.current = null;
            setQueuedTrack(null);
            dropUndoActions("track");
            if (roomRef.current?.onlineActive && isActiveRoleRef.current) {
              roomRef.current.requestClearTrackQueue?.();
            }
            setReleasedQueuedTrack({ name: queued, shouldPlay: playAfterRelease, id: Date.now() });
            return;
          }
        }
      },

      onSectionChange: (name) => {
        setCurrentSectionName(name ?? null);
        if (name && engineRef.current?.sectionData?.[name]?.type === "end") {
          dropUndoActionsMatching(action => action.kind === "track");
        }
      },
      onQueueChange: (nameOrNull) => {
        queuedSectionRef.current = nameOrNull;
        setQueuedSectionName(nameOrNull);
        if (!nameOrNull) dropUndoActions("section");
      },
      onModeChange: (modeName) => setCurrentModeName(modeName || "base"),
      onModeQueueChange: (nameOrNull) => {
        queuedModeRef.current = nameOrNull;
        setQueuedModeName(nameOrNull);
        if (!nameOrNull) dropUndoActions("mode");
      },
      onReady: () => { setClipProgress(0); },  // when engine finished resetting
    });
  }
  const engine = engineRef.current;

  // === Verification timers for late-join drift correction ===
  const verifyTimer1Ref = useRef(null);
  const verifyTimer2Ref = useRef(null);
  const verifyingRef = useRef(false);

  const scheduleSyncVerificationRef = useRef(null);

  // Audio unlock for late joiners
  useEffect(() => {
    const st = engine.getAudioState?.();
    setAudioLocked(st !== "running");
  }, [engine]);

  const handleEnableAudio = async () => {
    await engine.unlockAudio?.();
    setAudioLocked(engine.getAudioState?.() !== "running" ? true : false);

    // If we deferred a net start while locked, ask the GM for a fresh snapshot now.
    if (engine.getAudioState?.() === "running" && pendingNetStart) {
      try { room?.requestSync?.(); } catch {}
      setPendingNetStart(null);
    }

    // If we arrived mid-session, re-request sync to jump in immediately
    if (!pendingNetStart) room.requestSync();
  };

  // Keep engine fade setting in sync
  useEffect(() => {
    engine.setFadeOutSeconds?.(fadeOutSeconds);
  }, [engine, fadeOutSeconds]);

  useEffect(() => {
    engine.setPauseFadeSeconds?.(pauseFadeSeconds);
    try { localStorage.setItem("wizamp_pauseFade", String(pauseFadeSeconds)); } catch {}
  }, [engine, pauseFadeSeconds]);

  // Keep refs in sync
  useEffect(() => { selectedTrackRef.current = selectedTrack; }, [selectedTrack]);
  useEffect(() => { playingTrackNameRef.current = playingTrackName; }, [playingTrackName]);
  useEffect(() => { autoplayRef.current = autoplay; }, [autoplay]);
  useEffect(() => { isActiveRoleRef.current = isActiveRole; }, [isActiveRole]);
  useEffect(() => { queuedSectionRef.current = queuedSectionName; }, [queuedSectionName]);
  useEffect(() => { queuedModeRef.current = queuedModeName; }, [queuedModeName]);
  useEffect(() => () => clearTimeout(undoEffectTimerRef.current), []);

  // Track select menu persist (optional)
  useEffect(() => { localStorage.setItem("wizamp_dbSort", dbSort); }, [dbSort]);
  useEffect(() => {
    try { localStorage.setItem("wizamp_librarySort", librarySort); } catch { /* Storage may be disabled. */ }
  }, [librarySort]);
  useEffect(() => {
    try { localStorage.setItem("wizamp_libraryFilters", JSON.stringify(libraryFilters)); } catch { /* Storage may be disabled. */ }
  }, [libraryFilters]);

  // Pinned effect
  useEffect(() => {
    try {
      localStorage.setItem("wizamp_pinned", JSON.stringify(Array.from(pinned)));
    } catch {}
  }, [pinned]);


  // When a track is selected, point UI at its first section
  useEffect(() => {
    if (isActive) return;         // ← don’t switch UI when playing *or paused*
    if (!selectedTrack) {
      setCurrentSectionName(null);
      setQueuedSectionName(null);
      return;
    }
    const first = tracks[selectedTrack]?.firstSection || null;
    setCurrentSectionName(first);
    setQueuedSectionName(null);
  }, [selectedTrack, tracks, isActive]);

  // Derived: firstSection of the selected track (for Transport button label)
  const firstSection = useMemo(() => {
    if (!selectedTrack) return null;
    const track = tracks[selectedTrack];
    return track ? track.firstSection : null;
  }, [selectedTrack, tracks]);

  const autoLockedTargets = useMemo(() => {
    return getAutoLockedTargets(sections[currentSectionName]);
  }, [sections, currentSectionName]);

  // RAF loop for clip progress
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const info = engine.getPlaybackInfo?.();
      setClipProgress(info?.progress01 ?? 0);
      setClipPositionSeconds(info?.positionSeconds ?? 0);
      setClipDurationSeconds(info?.durationSeconds ?? 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  useEffect(() => {
    if (!queuedTrack && !queuedSectionName && !queuedModeName) {
      queuedTrackTimingRef.current = null;
      queuedChoiceTimingRef.current = { section: null, mode: null };
      setQueuedTrackProgress(null);
      setQueuedChoiceProgress(previous => previous.section == null && previous.mode == null ? previous : { section: null, mode: null });
      return undefined;
    }

    const update = () => {
      const timing = engine.getTrackExitTiming?.();
      const trackCanCountDown = queuedTrack && (
        replacementPending || timing?.kind === "fade" || sections[currentSectionName]?.type === "end"
      );
      const trackRemaining = trackCanCountDown
        ? replacementRemainingSeconds({ clips, sections, currentSectionName, queuedSectionName, timing })
        : null;
      if (!Number.isFinite(trackRemaining)) {
        queuedTrackTimingRef.current = null;
        setQueuedTrackProgress(null);
      } else {
        const kind = timing.kind;
        if (queuedTrackTimingRef.current?.track !== queuedTrack || queuedTrackTimingRef.current?.kind !== kind) {
          queuedTrackTimingRef.current = {
            track: queuedTrack,
            kind,
            total: kind === "fade" ? timing.totalSeconds : trackRemaining,
          };
        }
        const total = Math.max(queuedTrackTimingRef.current.total || 0, 0.001);
        setQueuedTrackProgress(Math.max(0, Math.min(1, 1 - trackRemaining / total)));
      }

      const boundaryRemaining = timing?.kind === "clip" ? timing.toBoundarySeconds : null;
      const choiceProgress = {};
      for (const [kind, name] of [["section", queuedSectionName], ["mode", queuedModeName]]) {
        if (!name || !Number.isFinite(boundaryRemaining)) {
          queuedChoiceTimingRef.current[kind] = null;
          choiceProgress[kind] = null;
          continue;
        }
        const key = `${name}:${timing.clipName}:${timing.startedAt}`;
        if (queuedChoiceTimingRef.current[kind]?.key !== key) {
          queuedChoiceTimingRef.current[kind] = { key, total: boundaryRemaining };
        }
        const total = Math.max(queuedChoiceTimingRef.current[kind].total, 0.001);
        choiceProgress[kind] = Math.max(0, Math.min(1, 1 - boundaryRemaining / total));
      }
      setQueuedChoiceProgress(previous => (
        previous.section === choiceProgress.section && previous.mode === choiceProgress.mode
          ? previous
          : choiceProgress
      ));
    };
    update();
    const interval = window.setInterval(update, 50);
    return () => window.clearInterval(interval);
  }, [engine, queuedTrack, replacementPending, clips, sections, currentSectionName, queuedSectionName, queuedModeName]);

  // Handlers
  const handlePlay = async () => {
    await engine.unlockAudio();
    // If audio is locked, don't start or advance RNG. Defer until unlock, then re-sync.
    if (engine.getAudioState?.() !== "running") {
      setAudioLocked(true);           // show the banner if you have it
      setPendingNetStart({ type: "PLAY", ts: Date.now() });
      // Do not call engine.play... here. Just wait for unlock.
      return;
    }

    if (isLoadingTrack) return;  // <-- early bail

    if (!playingTrackName && queuedTrackRef.current) {
      await requestTrackPlayback(queuedTrackRef.current, { shouldPlay: true });
      return;
    }

    if (!engine.isPreloaded || playingTrackName !== selectedTrack) return;

    const target = currentSectionName || firstSection;
    if (target) {
      if (room.onlineActive && isActiveRole) {
        // enforce ready gate by default
        if (!room.allReady) {
          // Show something lightweight to the active user; you can replace with your modal/toast
          console.warn("Not all players are ready:", room.users.filter(u => !u.ready).map(u => u.name));
          // Optionally, uncomment to force play anyway:
          // room.requestPlay({ trackName: selectedTrack, sectionName: target, delayMs: 2000, override: true });
          return;
        }
        room.requestPlay({ trackName: selectedTrack, sectionName: target, delayMs: 2000 });
      } else {
        engine.playSection(target);
      }
    }
  };

  const handlePause = () => {
    if (replacementPendingRef.current) return;
    const simple = !!tracks[playingTrackName || selectedTrack]?.simple;
    if (room.onlineActive && isActiveRole) {
      room.requestPause();
    } else {
      engine.pause(simple);
    }
  };

  const handleResume = async () => {
    if (replacementPendingRef.current) return;
    await engine.unlockAudio();
    if (engine.getAudioState?.() !== "running") {
      setAudioLocked(true);
      setPendingNetStart({ type: "RESUME", ts: Date.now() });
      return;
    }

    const simple = !!tracks[playingTrackName || selectedTrack]?.simple;
    if (room.onlineActive && isActiveRole) {
      room.requestResume({ delayMs: 1000 }); // small lead time like Play
    } else {
      engine.resume(simple);
    }
  };

  const handleStop = async ({ recordUndo = true } = {}) => {
    if (recordUndo && isActive && Number(fadeOutSeconds) > 0) {
      dropUndoActions("stop");
      pushUndoAction({ kind: "stop", previous: "playing", next: "stopping" });
    }
    if (room.onlineActive && isActiveRole) {
      // Tell everyone to stop (with fade)
      room.requestStop(true);
    } else {
      // Local stop only
      engine.stopTrack(true);
    }
  };


  const loadSavedTrackVolume = useCallback((name) => {
    try {
      const k = `wizamp:trackVolume:${name}`;
      const v = localStorage.getItem(k);
      const num = v == null ? 1 : Math.max(0, Math.min(1, Number(v)));
      return Number.isFinite(num) ? num : 1;
    } catch { return 1; }
  }, []);

  const saveTrackVolume = (name, vol) => {
    try {
      const k = `wizamp:trackVolume:${name}`;
      localStorage.setItem(k, String(vol));
    } catch {}
  };

  const handleSelectTrack = useCallback((name) => {

    // Only update selection + volume now; actual loading is deferred until STOP.
    if (failedLoadRef.current === name) setLoadAttempt(attempt => attempt + 1);
    selectedTrackRef.current = name;
    failedLoadRef.current = null;
    setSelectedTrack(name);
    const savedVol = loadSavedTrackVolume(name);
    setTrackVolume(savedVol);
  }, [loadSavedTrackVolume]);

  const requestPlaybackAfterLoad = useCallback((name) => {
    setPlayRequestedFor(name);
  }, []);

  useEffect(() => {
    if (!releasedQueuedTrack) return;
    const { name, shouldPlay } = releasedQueuedTrack;
    handleSelectTrack(name);
    if (roomRef.current?.onlineActive && isActiveRole) roomRef.current.requestSetTrack?.(name);
    if (shouldPlay && (!roomRef.current?.onlineActive || isActiveRole)) requestPlaybackAfterLoad(name);
    setReleasedQueuedTrack(null);
  }, [releasedQueuedTrack, handleSelectTrack, requestPlaybackAfterLoad, isActiveRole]);

  // Called when server sends STATE { name, seed, ... }.
  // It should ONLY select/preload, never start playback here.
  const onSetTrack = useCallback(({ name, seed }) => {
    if (!name) return;

    // If already on this track, do nothing unless we're idle.
    const local = engine.getNowPlaying?.(); // {trackName, ...} or null
    const alreadySelected = selectedTrack === name || local?.trackName === name;

    if (alreadySelected) {
      // Optional: only reseed when we're not actively playing
      if (!isPlaying && seed != null) {
        console.log("[APP] engine.setRandomSeed(seed) (idle reseed)");
        engine.setRandomSeed?.(seed >>> 0);
      }
      return; // <- prevent any restart
    }

    // Not on this track yet: select & preload (no auto-start here)
    console.log("[APP] onSetTrack select/preload only:", name);
    if (seed != null) {
      engine.setRandomSeed?.(seed >>> 0);
    }
    handleSelectTrack(name); // this triggers the preload effect below
  }, [engine, selectedTrack, handleSelectTrack, isPlaying]);


  const getTrackAssets = useCallback(async (name) => {
    const cached = preparedTracksRef.current.get(name);
    if (cached) return cached;
    const pending = trackAssetPromisesRef.current.get(name);
    if (pending) return pending;

    const request = (async () => {
      const basePath = tracks[name]?.basePath || `/tracks/${name}`;
      const responses = await Promise.all(["clipData", "sectionData"].map(file => fetch(`${basePath}/${file}.json`)));
      if (responses.some(response => !response.ok)) throw new Error("Could not load track metadata");
      const [clipJson, sectionJson] = await Promise.all(responses.map(response => response.json()));
      const assets = {
        basePath,
        clips: clipJson.clips || clipJson,
        sections: sectionJson.sections || sectionJson,
        buffersReady: false,
      };
      preparedTracksRef.current.set(name, assets);
      return assets;
    })();

    trackAssetPromisesRef.current.set(name, request);
    try {
      return await request;
    } finally {
      trackAssetPromisesRef.current.delete(name);
    }
  }, [tracks]);

  const loadTrackAssets = useCallback(async (name) => {
    if (!name || engine.isPlaying || loadBusyRef.current) return;
    loadBusyRef.current = true;
    setIsLoadingTrack(true);
    roomRef.current?.setReady(false);
    try {
      const assets = await getTrackAssets(name);
      if (selectedTrackRef.current !== name) return;
      const { clips: nextClips, sections: nextSections, basePath } = assets;
      engine.setData({ clips: nextClips, sections: nextSections, tracks });
      await engine.preloadTrack(name, {
        trackVolume: loadSavedTrackVolume(name),
        basePath,
        preserveCache: assets.buffersReady,
      });
      assets.buffersReady = false;
      if (selectedTrackRef.current !== name) {
        setPlayingTrackName(null);
        return;
      }
      setClips(nextClips);
      setSections(nextSections);
      setPlayingTrackName(name);
      setClipProgress(0);
      failedLoadRef.current = null;
      roomRef.current?.setReady(true);
      if (pendingPlayRef.current?.trackName === name) {
        pendingPlayRef.current = null;
        roomRef.current?.requestSync();
      }
    } catch (err) {
      failedLoadRef.current = name;
      setStatus(`Failed to load ${name}: ${err.message}. Select the track again to retry.`);
    } finally {
      loadBusyRef.current = false;
      setIsLoadingTrack(false);
    }
  }, [engine, tracks, loadSavedTrackVolume, getTrackAssets]);

  const scheduledCommandsRef = useRef(new Set());
  const cancelScheduledCommands = useCallback(() => {
    scheduledCommandsRef.current.forEach(clearTimeout);
    scheduledCommandsRef.current.clear();
  }, []);
  const scheduleAtServerTime = useCallback((serverMs, fn) => {
    const delay = Math.max(0, serverMs - (roomRef.current?.serverNowMs() ?? Date.now()));
    const id = setTimeout(() => { scheduledCommandsRef.current.delete(id); fn(); }, delay);
    scheduledCommandsRef.current.add(id);
  }, []);
  useEffect(() => cancelScheduledCommands, [cancelScheduledCommands, roomId, onlineEnabled]);

  const onPauseMsg = useCallback(() => {
    cancelScheduledCommands();
    const simple = !!tracks[playingTrackName || selectedTrack]?.simple;

    engine.pause(simple);
  }, [tracks, playingTrackName, selectedTrack, engine, cancelScheduledCommands]);

  const onStopMsg = useCallback((fade = true) => {
    cancelScheduledCommands();
    pendingPlayRef.current = null;
    if (queuedTrackRef.current) setReplacementInProgress(true);
    engine.stopTrack(fade);
  }, [engine, cancelScheduledCommands, setReplacementInProgress]);

  const onCancelStopMsg = useCallback(() => {
    engine.cancelStopFade?.();
    dropUndoActions("stop");
    setReplacementInProgress(false);
  }, [engine, dropUndoActions, setReplacementInProgress]);

  const onResumeMsg = useCallback((serverMs) => {
    const simple = !!tracks[playingTrackName || selectedTrack]?.simple;
    scheduleAtServerTime(serverMs, () => {

      engine.resume(simple);
    });
  }, [tracks, playingTrackName, selectedTrack, engine, scheduleAtServerTime]);

  const onSeekMsg = useCallback(({ positionSeconds, serverMs }) => {
    const seek = () => engine.seekSimpleTrack?.(positionSeconds);
    if (Number.isFinite(serverMs)) scheduleAtServerTime(serverMs, seek);
    else seek();
  }, [engine, scheduleAtServerTime]);

  const onQueueSectionMsg = useCallback((name) => {
    if (shouldIgnoreQueues()) {
      console.log("[SYNC][IGNORE] dropping stale QUEUE_SECTION during hydrate window:", name);
      return;
    }
    queuedSectionRef.current = name || null;
    setQueuedSectionName(name || null);
    if (name && queuedTrackRef.current && sections[name]?.type === "end") {
      setReplacementInProgress(true);
    } else if (name && sections[name]?.type !== "end" && sections[engine.currentSectionName]?.type !== "end") {
      setReplacementInProgress(false);
    }
    if (name) engine.queueSectionTransition?.(name);
  }, [engine, shouldIgnoreQueues, sections, setReplacementInProgress]);

  const onClearSectionQueueMsg = useCallback(() => {
    queuedSectionRef.current = null;
    setQueuedSectionName(null);
    engine.clearQueuedSection?.();
    dropUndoActions("section");
    if (sections[engine.currentSectionName]?.type !== "end") setReplacementInProgress(false);
  }, [engine, dropUndoActions, sections, setReplacementInProgress]);

  const onQueueModeMsg = useCallback((name) => {
    if (shouldIgnoreQueues()) {
      console.log("[SYNC][IGNORE] dropping stale QUEUE_MODE during hydrate window:", name);
      return;
    }
    queuedModeRef.current = name || null;
    setQueuedModeName(name || null);
    if (name) engine.queueModeTransition?.(name);
  }, [engine, shouldIgnoreQueues]);

  const onClearModeQueueMsg = useCallback(() => {
    queuedModeRef.current = null;
    setQueuedModeName(null);
    engine.clearQueuedMode?.();
    dropUndoActions("mode");
  }, [engine, dropUndoActions]);

  const onQueueTrackMsg = useCallback((name, playAfterRelease = null) => {
    if (!name) return;
    const alreadyQueued = queuedTrackRef.current === name;
    queuedTrackRef.current = name;
    queuedTrackPlayAfterReleaseRef.current = typeof playAfterRelease === "boolean" ? playAfterRelease : null;
    setQueuedTrack(name);
    if (sections[queuedSectionRef.current]?.type === "end") setReplacementInProgress(true);
    if (alreadyQueued) return;
    void (async () => {
      try {
        const assets = await getTrackAssets(name);
        await engine.cacheTrackBuffers(name, assets.clips, { basePath: assets.basePath });
        assets.buffersReady = true;
      } catch (queueError) {
        console.error(`[QUEUE] Failed to prepare ${name}`, queueError);
      }
    })();
  }, [engine, getTrackAssets, sections, setReplacementInProgress]);

  const onClearTrackQueueMsg = useCallback(() => {
    queuedTrackRef.current = null;
    queuedTrackPlayAfterReleaseRef.current = null;
    setQueuedTrack(null);
    dropUndoActions("track");
  }, [dropUndoActions]);

  const onSetTrackVolumeMsg = useCallback((vol) => {
    const v = Math.max(0, Math.min(1, Number(vol)));
    setTrackVolume(v);
    if (playingTrackName) saveTrackVolume(playingTrackName, v);
    engine.setTrackVolume?.(v);
  }, [engine, playingTrackName]);

  const onSetAutoplayMsg = useCallback((val) => {
    setAutoplay(!!val);
  }, []);

  const onSyncRequestMsg = useCallback((requesterId) => {
    // Build a precise snapshot from the engine (GM side)
    const snapshot = engine.getNowPlaying?.();
    if (!snapshot) return;

    // Current draw count up to "now"
    const drawCount =
      (engine.getRngDrawCount?.() != null
        ? engine.getRngDrawCount()
        : (snapshot.rngDrawCount ?? 0));

    const state = {
      ...snapshot,              // {trackName, sectionName, modeName, clipName, offsetSeconds, seed, ...}
      volume: trackVolume ?? 1, // include current room volume for the joiner
      rngDrawCount: drawCount,  // for debugging / fallback
      rngNext: drawCount + 1,   // <- the next draw the GM will consume at the next boundary
    };

    // Use the ref (may still be null on first render; that’s OK)
    sendSyncResponseRef.current?.(requesterId, state);
  }, [engine, trackVolume]);

  // Schedule a verification SYNC right after the next loop boundary
  useEffect(() => {
    scheduleSyncVerificationRef.current = () => {
      // clear any previous timers
      if (verifyTimer1Ref.current) { clearTimeout(verifyTimer1Ref.current); verifyTimer1Ref.current = null; }
      if (verifyTimer2Ref.current) { clearTimeout(verifyTimer2Ref.current); verifyTimer2Ref.current = null; }

      const nowPlaying = engine.getNowPlaying?.();
      if (!nowPlaying) return;

      const { clipName, offsetSeconds = 0 } = nowPlaying;

      // You already have this helper; if not, inline the lookup from `clips`.
      const c = clips?.[clipName];
      const lp = c ? Number(c.loopPoint) : null;

      // If we can’t resolve loopPoint/offset, do two coarse checks
      if (!lp || offsetSeconds == null) {
        verifyingRef.current = true;
        verifyTimer1Ref.current = setTimeout(() => requestSyncRef.current?.(), 900);
        verifyTimer2Ref.current = setTimeout(() => requestSyncRef.current?.(), 1600);
        return;
      }

      const remainMs = Math.max(60, (lp - offsetSeconds) * 1000);
      verifyingRef.current = true;

      // Right after boundary
      verifyTimer1Ref.current = setTimeout(() => requestSyncRef.current?.(), remainMs + 20);
      // Backup mid-next-clip
      verifyTimer2Ref.current = setTimeout(() => requestSyncRef.current?.(), remainMs + 420);
    };

    // Cleanup on unmount
    return () => {
      if (verifyTimer1Ref.current) { clearTimeout(verifyTimer1Ref.current); verifyTimer1Ref.current = null; }
      if (verifyTimer2Ref.current) { clearTimeout(verifyTimer2Ref.current); verifyTimer2Ref.current = null; }
    };
  }, [engine, clips]); // NOTE: no `room` and no `onSyncStateMsg` here

  const onSyncStateMsg = useCallback((snapshot) => {
    // (A) If the snapshot happens to include queued fields, never enact them here.
    //     We only *display* queues on the GM and we execute queues via explicit QUEUE_* events.
    if (snapshot?.queuedSection || snapshot?.queuedMode) {
      const qs = snapshot?.queuedSection ?? null;
      const qm = snapshot?.queuedMode ?? null;
      if (!isActiveRole || shouldIgnoreQueues()) {
        console.log("[SYNC_STATE][IGNORE] queued fields present in snapshot (hydrate/non-GM):", { qs, qm });
      } else {
        console.log("[SYNC_STATE] queued fields (GM display only):", { qs, qm });
      }
    }

    // (B) Verification path (post-hydrate re-check)
    if (verifyingRef.current) {
      verifyingRef.current = false;
      if (verifyTimer1Ref.current) { clearTimeout(verifyTimer1Ref.current); verifyTimer1Ref.current = null; }
      if (verifyTimer2Ref.current) { clearTimeout(verifyTimer2Ref.current); verifyTimer2Ref.current = null; }

      const local = engine.getNowPlaying?.();
      const localDraw  = engine.getRngDrawCount?.() | 0;
      const remoteDraw = (snapshot?.rngDrawCount | 0);
      const drawDiff   = remoteDraw - localDraw;

      // RNG correction (authoritative = remote/GM)
      if (drawDiff !== 0) {
        console.log("[VERIFY][RNG] correcting draw from", localDraw, "to", remoteDraw);
        if (Number.isFinite(snapshot?.seed)) engine.setRandomSeed?.(snapshot.seed);
        engine.fastForwardRng?.(remoteDraw);
      }

      // Positional correction (authoritative = remote/GM)
      const needJump =
        !local ||
        local.sectionName !== snapshot?.sectionName ||
        local.modeName    !== snapshot?.modeName ||
        local.clipName    !== snapshot?.clipName ||
        Math.abs((local?.offsetSeconds || 0) - (snapshot?.offsetSeconds || 0)) > 0.06;

      if (needJump) {
        console.log("[VERIFY] position correction →", {
          section: snapshot?.sectionName,
          mode:    snapshot?.modeName,
          clip:    snapshot?.clipName,
          off:     snapshot?.offsetSeconds
        });

        // Clear any stale queues before we jump
        engine.clearQueuedSection?.();
        setQueuedSectionName(null);
        engine.clearQueuedMode?.();
        setQueuedModeName(null);

        // Hydrate guard so any delayed QUEUE_* from STATE can’t fire right away
        setHydrateGuard(3000);

        engine.playAtPosition?.({
          sectionName: snapshot?.sectionName,
          modeName:    snapshot?.modeName || "base",
          clipName:    snapshot?.clipName,
          offsetSeconds: Math.max(0, Number(snapshot?.offsetSeconds) || 0),
          warmStartDeltaSec: 0
        });

        // Schedule a follow-up verification
        scheduleSyncVerificationRef.current?.();

        // Re-allow queues after we’ve scheduled verification
        ignoreQueueUntilMsRef.current = 0;
      } else {
        console.log("[VERIFY] already in sync.");
      }
      return;
    }

    // (C) Normal late-join hydrate
    const name = snapshot?.trackName || snapshot?.name || snapshot?.selectedTrack || null;
    if (!name) return;

    // Don’t re-preload if we already have this track loaded
    const sameTrackAndLoaded = (playingTrackName === name) && !!engine.isPreloaded;

    // Apply seed + fast-forward RNG to the exact draw count in the snapshot.
    if (Number.isFinite(snapshot?.seed)) {
      engine.setRandomSeed?.(snapshot.seed);
    }
    const draws = (snapshot?.rngDrawCount | 0);
    if (draws > 0) engine.fastForwardRng?.(draws);

    if (sameTrackAndLoaded) {
      // Clear any stale queues before the precise jump
      engine.clearQueuedSection?.();
      setQueuedSectionName(null);
      engine.clearQueuedMode?.();
      setQueuedModeName(null);

      // Hydrate guard so queued items in STATE can't re-fire right away
      setHydrateGuard(3000);

      // Jump into exact musical position
      engine.playAtPosition?.({
        sectionName: snapshot.sectionName,
        modeName:    snapshot.modeName || "base",
        clipName:    snapshot.clipName,
        offsetSeconds: Math.max(0, Number(snapshot.offsetSeconds) || 0),
        warmStartDeltaSec: 0
      });

      // Verify on/after next boundary
      scheduleSyncVerificationRef.current?.();
      ignoreQueueUntilMsRef.current = 0;
      return;
    }

    // Not preloaded yet: select & preload. Your preload path already re-requests a SYNC after load.
    pendingPlayRef.current = { trackName: name };
    handleSelectTrack(name);
  }, [
    engine,
    playingTrackName,
    isActiveRole,          // ⬅️ use this (your code’s “GM” boolean)
    shouldIgnoreQueues,
    setHydrateGuard,
    scheduleSyncVerificationRef,
    handleSelectTrack
  ]);

  const room = useRoom({
    onlineEnabled,
    roomId,
    displayName,
    role,
    onSetTrack,
    onPlay: ({ trackName, sectionName, serverMs }) => {
      // Late-join friendliness:
      // 1) If assets not ready, ensure selection + preload first.
      // 2) After preload, schedule at max(serverMs, serverNow + 1500ms) so everyone lines up.
      const needPreload = !playingTrackName || playingTrackName !== trackName;
      // Snap the UI track selector if needed (no load yet)
      if (trackName && trackName !== selectedTrack) handleSelectTrack(trackName);
      if (!sectionName || !serverMs) return;
      if (needPreload || isLoadingTrack) {
        pendingPlayRef.current = { trackName, sectionName, serverMs };
      } else {
        // We are ready: schedule with a safety lead time if serverMs already passed
        const now = room.serverNowMs ? room.serverNowMs() : Date.now();
        const target = Math.max(serverMs, now);
        scheduleSectionAtServerTime(sectionName, target);
      }
    },
    onPause: onPauseMsg,
    onStop: onStopMsg,
    onCancelStop: onCancelStopMsg,
    onResume: onResumeMsg,
    onSeek: onSeekMsg,
    onQueueSection: onQueueSectionMsg,
    onClearSectionQueue: onClearSectionQueueMsg,
    onQueueMode: onQueueModeMsg,
    onClearModeQueue: onClearModeQueueMsg,
    onQueueTrack: onQueueTrackMsg,
    onClearTrackQueue: onClearTrackQueueMsg,
    onSetTrackVolume: onSetTrackVolumeMsg,
    onSetAutoplay: onSetAutoplayMsg,
    onSyncRequest: onSyncRequestMsg,
    onSyncState: onSyncStateMsg,
  });
  useEffect(() => { roomRef.current = room; }, [room]);

  const handleSeek = useCallback((positionSeconds) => {
    if (!Number.isFinite(positionSeconds)) return;
    if (room.onlineActive && isActiveRole) {
      room.requestSeek?.({ positionSeconds });
    } else {
      engine.seekSimpleTrack?.(positionSeconds);
    }
  }, [engine, room, isActiveRole]);

  const roomState = {
    isOnline: onlineEnabled,
    users: room?.users ?? [],
    presenceReady: room?.presenceReady ?? false,
    latencyMs: room?.latencyMs ?? null,
    serverOffsetMs: room?.offsetMs ?? null,
  };

  // Proxies to avoid cyclic deps
  const requestSyncRef = useRef(null);
  useEffect(() => {
    requestSyncRef.current = () => room?.requestSync?.();
  }, [room]);

  useEffect(() => {
    sendSyncResponseRef.current = room.sendSyncResponse;
    return () => { sendSyncResponseRef.current = null; };
  }, [room.sendSyncResponse]);

  // Selection changes during playback take effect only after a complete stop.
  useEffect(() => {
    if (!isActive && !isLoadingTrack && selectedTrack && failedLoadRef.current !== selectedTrack
        && (!playingTrackName || selectedTrack !== playingTrackName)) {
      loadTrackAssets(selectedTrack);
    }
  }, [isActive, isLoadingTrack, selectedTrack, playingTrackName, loadTrackAssets, loadAttempt]);

  // Explicit Play actions are honored after selection/preloading, regardless of Auto-Play.
  useEffect(() => {
    const name = playRequestedFor;
    if (!name || name !== selectedTrack || name !== playingTrackName || isLoadingTrack || isActive) return;
    const sectionName = tracks[name]?.firstSection;
    if (!sectionName) return;
    if (room.onlineActive) {
      if (!isActiveRole || !room.connected || !room.allReady) return;
      room.requestPlay({ trackName: name, sectionName });
    } else {
      engine.playSection(sectionName);
    }
    setPlayRequestedFor(null);
  }, [playRequestedFor, selectedTrack, playingTrackName, isLoadingTrack, isActive, tracks, room, isActiveRole, engine]);

  // Set user volume
  useEffect(() => {
    engine.setUserVolume?.(userMuted ? 0 : userVolume);
  }, [engine, userVolume, userMuted]);

  // Persist the selected track's slider changes (always)
  useEffect(() => {
    // whenever trackVolume changes for the selected track, apply + persist
    if (!selectedTrack) return;
    saveTrackVolume(selectedTrack, trackVolume);
  }, [selectedTrack, trackVolume]);

  // Apply volume to the engine for the playing track only
  useEffect(() => {
    if (!playingTrackName) return;
    // If the selected track is the one playing, use the slider value
    if (selectedTrack === playingTrackName) {
      engine.setTrackVolume?.(trackVolume);
    } else {
      // Otherwise, load the saved volume for the currently playing track
      const v = loadSavedTrackVolume(playingTrackName);
      engine.setTrackVolume?.(v);
    }
  }, [engine, playingTrackName, selectedTrack, trackVolume, loadSavedTrackVolume]);

  const scheduleSectionAtServerTime = (sectionName, serverMs) => {
    cancelScheduledCommands();
    scheduleAtServerTime(serverMs, () => {
      if (engine.getAudioState() !== 'running') {
        setAudioLocked(true);
        setPendingNetStart({ type: 'PLAY' });
        return;
      }
      engine.clearQueuedSection();
      engine.clearQueuedMode();
      engine.playSection(sectionName);
    });
  };

  function selectTrackForRoom(name) {
    handleSelectTrack(name);
    if (room.onlineActive && isActiveRole) {
      room.requestSetTrack?.(name);
    }
  }

  function pushUndoAction(action) {
    if (action.previous === action.next && action.previousPlayAfterRelease === action.nextPlayAfterRelease && !action.sectionNext) return;
    updateUndoHistory(previous => [...previous, { ...action, id: `${Date.now()}-${previous.length}` }]);
  }

  function showUndoEffect(action) {
    clearTimeout(undoEffectTimerRef.current);
    setUndoEffect({ ...action, effectId: Date.now() });
    undoEffectTimerRef.current = setTimeout(() => setUndoEffect(null), 720);
  }

  function applySectionQueue(nameOrNull, { broadcast = true } = {}) {
    queuedSectionRef.current = nameOrNull;
    setQueuedSectionName(nameOrNull);
    if (broadcast && room.onlineActive && isActiveRole) {
      if (nameOrNull) room.requestQueueSection(nameOrNull);
      else room.requestClearSectionQueue();
    } else if (!room.onlineActive) {
      if (nameOrNull) engine.queueSectionTransition?.(nameOrNull);
      else engine.clearQueuedSection?.();
    }
  }

  function applyModeQueue(nameOrNull, { broadcast = true } = {}) {
    queuedModeRef.current = nameOrNull;
    setQueuedModeName(nameOrNull);
    if (broadcast && room.onlineActive && isActiveRole) {
      if (nameOrNull) room.requestQueueMode(nameOrNull);
      else room.requestClearModeQueue();
    } else if (!room.onlineActive) {
      if (nameOrNull) engine.queueModeTransition?.(nameOrNull);
      else engine.clearQueuedMode?.();
    }
  }

  function queueSectionSelection(nameOrNull) {
    if (replacementPendingRef.current) return;
    const previous = queuedSectionRef.current;
    if (previous === nameOrNull) return;
    if (nameOrNull) pushUndoAction({ kind: "section", previous, next: nameOrNull });
    else dropUndoActions("section");
    applySectionQueue(nameOrNull);
  }

  function queueModeSelection(nameOrNull) {
    if (replacementPendingRef.current) return;
    const previous = queuedModeRef.current;
    if (previous === nameOrNull) return;
    if (nameOrNull) pushUndoAction({ kind: "mode", previous, next: nameOrNull });
    else dropUndoActions("mode");
    applyModeQueue(nameOrNull);
  }

  function clearTrackQueue({ broadcast = false, pruneHistory = true } = {}) {
    queuedTrackRef.current = null;
    queuedTrackPlayAfterReleaseRef.current = null;
    setQueuedTrack(null);
    if (pruneHistory) dropUndoActions("track");
    if (broadcast && room.onlineActive && isActiveRole) room.requestClearTrackQueue?.();
  }

  function undoLastQueuedChange() {
    const action = undoHistoryRef.current.at(-1);
    if (!action) return;
    updateUndoHistory(previous => previous.slice(0, -1));
    showUndoEffect(action);

    if (action.kind === "stop") {
      if (room.onlineActive && isActiveRole) room.requestCancelStop?.();
      else engine.cancelStopFade?.();
    } else if (action.kind === "track") {
      if (action.stopPending || action.sectionNext) setReplacementInProgress(false);
      if (action.stopPending) {
        if (room.onlineActive && isActiveRole) room.requestCancelStop?.();
        else engine.cancelStopFade?.();
      }
      if (action.previous) void addTrackToQueue(action.previous, { recordUndo: false, playAfterRelease: action.previousPlayAfterRelease ?? null });
      else clearTrackQueue({ broadcast: true, pruneHistory: false });
      if (action.sectionNext && queuedSectionRef.current === action.sectionNext) {
        applySectionQueue(action.sectionPrevious || null);
      }
    } else if (action.kind === "section") {
      applySectionQueue(action.previous || null);
    } else if (action.kind === "mode") {
      applyModeQueue(action.previous || null);
    }
  }

  async function requestTrackPlayback(name, { alwaysStop = false, shouldPlay = true } = {}) {
    if (!name || (!isActiveRole && room.onlineActive)) return;
    await engine.unlockAudio?.();
    if (!isActive) {
      clearTrackQueue({ broadcast: true });
      selectTrackForRoom(name);
      if (shouldPlay) requestPlaybackAfterLoad(name);
      else setPlayRequestedFor(null);
      return;
    }

    if (replacementPendingRef.current) {
      void addTrackToQueue(name, { playAfterRelease: shouldPlay });
      return;
    }

    // While another track is active, prepare the requested track without
    // disturbing live playback. The explicit Play or Load choice follows the queue.
    const previousTrack = queuedTrackRef.current;
    const previousPlayAfterRelease = queuedTrackPlayAfterReleaseRef.current;
    const previousSection = queuedSectionRef.current;
    setReplacementInProgress(true);
    void addTrackToQueue(name, { recordUndo: false, playAfterRelease: shouldPlay });
    if (alwaysStop || isPaused) {
      pushUndoAction({ kind: "track", previous: previousTrack, next: name, previousPlayAfterRelease, nextPlayAfterRelease: shouldPlay, stopPending: true });
      handleStop({ recordUndo: false });
      return;
    }

    const currentSection = sections[currentSectionName];
    if (currentSection?.type === "end") {
      dropUndoActions("track");
      return;
    }
    const endSection = findSelectableEndSection(sections, currentSectionName);
    if (endSection) {
      applySectionQueue(endSection);
      pushUndoAction({
        kind: "track",
        previous: previousTrack,
        next: name,
        previousPlayAfterRelease,
        nextPlayAfterRelease: shouldPlay,
        sectionPrevious: previousSection,
        sectionNext: endSection,
      });
    } else {
      pushUndoAction({ kind: "track", previous: previousTrack, next: name, previousPlayAfterRelease, nextPlayAfterRelease: shouldPlay, stopPending: true });
      handleStop({ recordUndo: false });
    }
  }

  async function addTrackToQueue(name, { recordUndo = true, broadcast = true, playAfterRelease = null } = {}) {
    if (!name || (!isActiveRole && room.onlineActive)) return;
    const previous = queuedTrackRef.current;
    const previousPlayAfterRelease = queuedTrackPlayAfterReleaseRef.current;
    if (previous === name && previousPlayAfterRelease === playAfterRelease) return;
    if (recordUndo) pushUndoAction({ kind: "track", previous, next: name, previousPlayAfterRelease, nextPlayAfterRelease: playAfterRelease });
    queuedTrackRef.current = name;
    queuedTrackPlayAfterReleaseRef.current = playAfterRelease;
    setQueuedTrack(name);
    if (broadcast && room.onlineActive && isActiveRole) room.requestQueueTrack?.(name, { playAfterRelease });
    if (previous === name) return;
    try {
      const assets = await getTrackAssets(name);
      await engine.cacheTrackBuffers(name, assets.clips, { basePath: assets.basePath });
      assets.buffersReady = true;
    } catch (error) {
      if (queuedTrackRef.current === name) {
        clearTrackQueue({ broadcast: true });
        if (!isActive) setStatus(`Failed to queue ${getTrackTitle(name)}: ${error.message}`);
        console.error(`[QUEUE] Failed to prepare ${name}`, error);
      }
    }
  }

  const clampLibraryWidth = (width) => Math.max(300, Math.min(Math.round(width), Math.floor(window.innerWidth * 0.6)));
  const resizeLibrary = (event) => {
    if (libraryResizePointer.current !== event.pointerId) return;
    setLibraryWidth(clampLibraryWidth(event.clientX - 12));
  };
  const finishLibraryResize = (event) => {
    if (libraryResizePointer.current !== event.pointerId) return;
    libraryResizePointer.current = null;
    setResizingLibrary(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const playingTrack = tracks[playingTrackName];
  const isStopHighlighted = playingTrack?.simple === true || (
    playingTrack?.simple === false &&
    Object.keys(sections).length > 0 &&
    !Object.values(sections).some((section) => section?.type === "end")
  );
  const changeAutoplay = (next) => {
    setAutoplay(!!next);
    if (room.onlineActive && isActiveRole) room.requestSetAutoplay?.(!!next);
  };

  return (
    <div className={`app-shell ${libraryExpanded ? "is-library-expanded" : "is-library-collapsed"} ${resizingLibrary ? "is-library-resizing" : ""} ${showStatus ? "" : "is-status-hidden"} ${isReadOnlyRole ? "is-role-read-only" : ""}`} style={{
      fontFamily: "sans-serif",
      padding: 20,
      "--library-width": `${libraryWidth}px`
      }}>

      <AboutModal
        open={showAbout}
        onClose={() => setShowAbout(false)}
        iconSrc={useAlternateIcon ? icon2bUrl : icon1Url}
        section={aboutSection}
        onSectionChange={setAboutSection}
      />

      <LeftPanel
        roomState={roomState}
        setRoomId={setRoomId}
        currentRoomId={roomId}
        role={role}
        setRole={setRole}
        displayName={displayName}
        setDisplayName={setDisplayName}
        roomIdentities={roomIdentities}
        setRoomIdentity={setRoomIdentity}
        themeChoices={themeChoices}
        onChooseTheme={chooseTheme}
        room={room}
        open={activeDrawer === "sessions"}
        onOpenChange={(open) => setActiveDrawer(open ? "sessions" : null)}
      />
      <AppMenu
        open={activeDrawer === "menu"}
        onOpenChange={(open) => setActiveDrawer(open ? "menu" : null)}
        canAccessDatabase={isActiveRole}
        onOpenDatabase={() => setDbOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        volumeExpanded={userVolumeOpen}
        onVolumeExpandedChange={setUserVolumeOpen}
        volume={userVolume}
        onVolumeChange={setUserVolume}
        muted={userMuted}
        onMutedChange={setUserMuted}
      />

      {!isReadOnlyRole && (
        <>
          <aside className={`track-library-shell ${effectiveMobileView === "library" ? "is-mobile-active" : ""}`}>
            <TrackList
              tracks={tracks}
              selectedTrack={selectedTrack}
              playingTrack={isActive ? playingTrackName : null}
              hasLoadedTrack={!!playingTrackName}
              queuedTrack={queuedTrack}
              queuedTrackProgress={queuedTrackProgress}
              undoEffect={undoEffect}
              disabled={!isActiveRole && room.onlineActive}
              sortMode={librarySort}
              onChangeSort={setLibrarySort}
              filters={libraryFilters}
              onChangeFilters={setLibraryFilters}
              pinned={pinned}
              names={names}
              onPlay={(name) => requestTrackPlayback(name)}
              onPlayAfterEnding={(name) => requestTrackPlayback(name, { shouldPlay: true })}
              onPlayAfterStopping={(name) => requestTrackPlayback(name, { alwaysStop: true, shouldPlay: true })}
              onLoadAfterEnding={(name) => requestTrackPlayback(name, { shouldPlay: false })}
              onLoadAfterStopping={(name) => requestTrackPlayback(name, { alwaysStop: true, shouldPlay: false })}
              onAddToQueue={addTrackToQueue}
              onCollapse={() => setLibraryExpanded(false)}
              onNavigateToControls={() => setMobileView("controls")}
            />
            <button
              type="button"
              className="track-library__resize-handle"
              aria-label="Resize track library"
              title="Drag or use arrow keys to resize track library"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                libraryResizePointer.current = event.pointerId;
                event.currentTarget.setPointerCapture(event.pointerId);
                setResizingLibrary(true);
              }}
              onPointerMove={resizeLibrary}
              onPointerUp={finishLibraryResize}
              onPointerCancel={finishLibraryResize}
              onLostPointerCapture={() => {
                libraryResizePointer.current = null;
                setResizingLibrary(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setLibraryWidth(width => clampLibraryWidth(width + (event.key === "ArrowRight" ? 20 : -20)));
              }}
            />
          </aside>
          {!libraryExpanded && (
            <button type="button" className="track-library-restore" onClick={() => setLibraryExpanded(true)} aria-label="Expand track library" title="Expand track library">
              <Icon name="chevronRight" size={19} />
            </button>
          )}
        </>
      )}

      {audioLocked && room.onlineActive && (
        <div
          style={{
            position: "fixed",
            top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(0,0,0,0.5)",   // dark backdrop
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            zIndex: 9999
          }}
          onClick={handleEnableAudio} // optional: close modal when clicking backdrop
        >
          <div
            style={{
              background: "rgba(20,20,20,0.95)",
              color: "#fff",
              padding: "20px 24px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.15)",
              maxWidth: 400,
              width: "100%",
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)"
            }}
            onClick={(e) => e.stopPropagation()} // prevent closing when clicking inside
          >
            <div style={{ fontWeight: 600, marginBottom: 12 }}>
              Audio is paused by the browser
            </div>
            <button
              onClick={handleEnableAudio}
              style={{
                cursor: "pointer",
                padding: "8px 14px",
                borderRadius: 6,
                border: "1px solid #aaa",
                background: "#1e90ff",
                color: "#fff",
              }}
            >
              Enable audio
            </button>
          </div>
        </div>
      )}

      <main className={`app-main ${effectiveMobileView === "controls" ? "is-mobile-active" : ""}`} style={{ width: "100%", maxWidth: 760, margin: "0 auto", flexDirection: "column" }}>
      <h1 className="visually-hidden">Wizamp</h1>

      <div className="playback-dock">
      {/* Simple tracks expose their linear timeline directly for seeking. */}
      {!isPassiveRole && playingTrack?.simple !== false && (
        <ClipProgress
          progress={clipProgress}
          positionSeconds={clipPositionSeconds}
          durationSeconds={clipDurationSeconds}
          showTimeline={playingTrack?.simple === true && isActive}
          seekable={playingTrack?.simple === true && isActive && !replacementPending && (!room.onlineActive || isActiveRole)}
          onSeek={handleSeek}
        />
      )}

      {/* Bottom-to-top hierarchy is Tracks, Sections, Modes, Clips. */}
      {!isPassiveRole && playingTrack?.simple === false && isActive && (
        <DynamicClipPanel
          expanded={dynamicClipsExpanded}
          onExpandedChange={setDynamicClipsExpanded}
          progress={clipProgress}
        />
      )}

      {/* Section and mode controls follow clips in the top-to-bottom layout. */}
      {currentSectionName && !isPassiveRole && (
        <section style={{ marginBottom: 16 }}>
          {!isPassiveRole && (
          <SectionPanel
            disabled={replacementPending || (!isActiveRole && room.onlineActive)}
            replacementLocked={replacementPending}
            sections={sections}
            currentSectionName={currentSectionName}
            queuedSectionName={queuedSectionName}
            undoEffect={undoEffect}
            autoLockedTargets={autoLockedTargets}
            onToggleQueuedSection={queueSectionSelection}
            largeButtons
            // NEW name resolvers
            getSectionTitle={(sectionKey) =>
              getSectionTitle(playingTrackName || selectedTrack, sectionKey)}
            getSectionButtonLabel={(sectionKey) =>
              getSectionButton(playingTrackName || selectedTrack, sectionKey)}
            getModeLabel={(sectionKey, modeNameOrBase) =>
              modeNameOrBase === "__base__"
                ? getBaseModeName(playingTrackName || selectedTrack, sectionKey)
                : getModeLabel(playingTrackName || selectedTrack, sectionKey, modeNameOrBase)}
            currentModeName={currentModeName}     // "base" or a mode name
            queuedModeName={queuedModeName}       // null or a mode name
            queuedSectionProgress={queuedChoiceProgress.section}
            queuedModeProgress={queuedChoiceProgress.mode}
            onToggleQueuedMode={queueModeSelection}
          />
        )}
      </section>
      )}

      {/* Transport Controls */}
      {!isPassiveRole && (
        <Transport
          disabled={!isActiveRole && room.onlineActive}
          primaryDisabled={(!playingTrackName && !queuedTrack) || replacementPending}
          stopDisabled={replacementPending}
          isLoadingTrack={isLoadingTrack}
          isPlaying={isPlaying}
          isPaused={isPaused}
          onPlay={handlePlay}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          onUndo={undoLastQueuedChange}
          undoDisabled={undoHistory.length === 0}
          undoLabel={undoHistory.at(-1)?.kind === "stop" ? "Undo stop" : undefined}
          isStopHighlighted={isStopHighlighted}
          unlockAudio={() => engine.unlockAudio?.()}
          leftControl={<AutoplayButton enabled={autoplay} onToggle={changeAutoplay} disabled={!isActiveRole && room.onlineActive} />}
          rightControl={selectedTrack ? (
            <TrackVolumeControl
              open={trackVolUIOpen}
              onOpenChange={setTrackVolUIOpen}
              volume={trackVolume}
              disabled={!isActiveRole}
              onVolumeChange={(volume) => {
                setTrackVolume(volume);
                engine.setTrackVolume?.(volume);
                if (playingTrackName && room.onlineActive && isActiveRole) {
                  room.requestSetTrackVolume(volume);
                }
              }}
            />
          ) : null}
        />
      )}

      {/* Playback queue with mirrored Auto-Play and track-volume controls */}
        <div className={`now-playing desktop-now-playing ${undoEffect?.kind === "track" ? "is-undoing" : ""}`}>
          {!isPassiveRole && <div className="now-playing__side"><AutoplayButton enabled={autoplay} onToggle={changeAutoplay} disabled={!isActiveRole && room.onlineActive} /></div>}
          <QueueIndicator currentTrack={playingTrackName} queuedTrack={queuedTrack} queuedTrackProgress={queuedTrackProgress} titleFor={getTrackTitle} />

          {!isPassiveRole && <div className="now-playing__side">
            <TrackVolumeControl
              open={trackVolUIOpen}
              onOpenChange={setTrackVolUIOpen}
              volume={trackVolume}
              disabled={!playingTrackName || !isActiveRole}
              onVolumeChange={(volume) => {
                setTrackVolume(volume);
                engine.setTrackVolume?.(volume);
                if (playingTrackName && room.onlineActive && isActiveRole) {
                  room.requestSetTrackVolume(volume);
                }
              }}
            />
          </div>}
        </div>
      </div>
      </main>

      {!isReadOnlyRole && (
        <section className={`mobile-playlists-view ${effectiveMobileView === "playlists" ? "is-mobile-active" : ""}`} aria-label="Playlists">
          <Icon name="playlist" size={32} />
          <strong>Playlists</strong>
          <span>Playlist support is coming later.</span>
        </section>
      )}

      {showStatus && <div className="utility-dock"><StatusBar text={displayedStatus} history={statusHistory} /></div>}

      <div className="mobile-queue-shortcut">
        <QueueIndicator
          currentTrack={playingTrackName}
          queuedTrack={queuedTrack}
          queuedTrackProgress={queuedTrackProgress}
          titleFor={getTrackTitle}
          expandable={effectiveMobileView === "controls"}
          locked={isReadOnlyRole}
          onActivate={() => setMobileView("controls")}
          navigationControl={!isReadOnlyRole ? (
            <PrimaryPlaybackButton
              compact
              disabled={(!playingTrackName && !queuedTrack) || replacementPending || (!isActiveRole && room.onlineActive)}
              isLoadingTrack={isLoadingTrack}
              isPlaying={isPlaying}
              isPaused={isPaused}
              onPlay={handlePlay}
              onPause={handlePause}
              onResume={handleResume}
              unlockAudio={() => engine.unlockAudio?.()}
            />
          ) : null}
        />
      </div>

      {!isReadOnlyRole && (
        <nav className={`mobile-tab-bar${showPlayControlsButton ? "" : " is-two-tab"}`} aria-label="Primary views">
          <button type="button" className={effectiveMobileView === "library" ? "is-active" : ""} onClick={() => setMobileView("library")} aria-pressed={effectiveMobileView === "library"}>
            <Icon name="library" size={18} />
            <span>Track Library</span>
          </button>
          {showPlayControlsButton && (
            <button type="button" className={effectiveMobileView === "controls" ? "is-active" : ""} onClick={() => setMobileView("controls")} aria-pressed={effectiveMobileView === "controls"}>
              <Icon name="controls" size={18} />
              <span>Play Controls</span>
            </button>
          )}
          <button type="button" className={effectiveMobileView === "playlists" ? "is-active" : ""} onClick={() => setMobileView("playlists")} aria-pressed={effectiveMobileView === "playlists"}>
            <Icon name="playlist" size={18} />
            <span>Playlists</span>
          </button>
        </nav>
      )}

      {/* Settings modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        cursorEffectEnabled={cursorEffectEnabled}
        setCursorEffectEnabled={setCursorEffectEnabled}
        fadeOutSeconds={fadeOutSeconds}
        setFadeOutSeconds={setFadeOutSeconds}
        pauseFadeSeconds={pauseFadeSeconds}
        setPauseFadeSeconds={setPauseFadeSeconds}
        showStatus={showStatus}
        setShowStatus={setShowStatus}
        showPlayControlsButton={showPlayControlsButton}
        setShowPlayControlsButton={setShowPlayControlsButton}
        useAlternateIcon={useAlternateIcon}
        setUseAlternateIcon={setUseAlternateIcon}
        onOpenAbout={() => { setSettingsOpen(false); setAboutSection("updates"); setShowAbout(true); }}
      />

      {/* Database modal */}
      {dbOpen && <DatabaseModal
        open={dbOpen}
        onClose={() => setDbOpen(false)}
        tracks={tracks}
        sortMode={dbSort}
        onChangeSort={setDbSort}
        pinned={pinned}
        onTogglePin={togglePin}
        names={names}                 // NEW
        onApplyRename={(target, fields) => {   // NEW save handler
          setNames(prev => {
            const next = structuredClone(prev ?? {});
            if (target.type === "track") {
              next.tracks ||= {};
              next.tracks[target.trackName] ||= {};
              // store override or remove if equal to default
              const def = tracks?.[target.trackName]?.defaultDisplayName ?? target.trackName;
              if (!fields.name || fields.name === def) {
                if (next.tracks[target.trackName]) delete next.tracks[target.trackName].displayName;
              } else {
                next.tracks[target.trackName].displayName = fields.name;
              }
            } else if (target.type === "section") {
              next.sections ||= {};
              next.sections[target.trackName] ||= {};
              next.sections[target.trackName][target.sectionKey] ||= {};
              const defName = target.defaults?.nameDefault ?? target.sectionKey;
              const defButton = target.defaults?.buttonDefault ?? "";

              // displayName
              if (!fields.name || fields.name === defName) {
                delete next.sections[target.trackName][target.sectionKey].displayName;
              } else {
                next.sections[target.trackName][target.sectionKey].displayName = fields.name;
              }
              // buttonName
              const btn = fields.button ?? "";
              if (btn === defButton || btn === "") {
                delete next.sections[target.trackName][target.sectionKey].buttonName;
              } else {
                next.sections[target.trackName][target.sectionKey].buttonName = btn;
              }
            } else if (target.type === "mode") {
              if (target.isBase) {
                next.sections ||= {};
                next.sections[target.trackName] ||= {};
                next.sections[target.trackName][target.sectionKey] ||= {};
                const defBase = target.defaults?.nameDefault ?? "base";
                if (!fields.name || fields.name === defBase) {
                  delete next.sections[target.trackName][target.sectionKey].baseModeName;
                } else {
                  next.sections[target.trackName][target.sectionKey].baseModeName = fields.name;
                }
              } else {
                next.modes ||= {};
                next.modes[target.trackName] ||= {};
                next.modes[target.trackName][target.sectionKey] ||= {};
                next.modes[target.trackName][target.sectionKey][target.modeName] ||= {};
                const defMode = target.defaults?.nameDefault ?? target.modeName;
                if (!fields.name || fields.name === defMode) {
                  delete next.modes[target.trackName][target.sectionKey][target.modeName].displayName;
                } else {
                  next.modes[target.trackName][target.sectionKey][target.modeName].displayName = fields.name;
                }
              }
            }
            return next;
          });
        }}
      />}

      <CursorEffect enabled={cursorEffectEnabled} themeId={activeTheme.id} effect={activeTheme.cursorEffect} />
    </div>
  );
}
