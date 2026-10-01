import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { activeTrackFilterCount, DEFAULT_TRACK_FILTERS, orderTracks, trackTitle } from "../data/trackOrdering";
import { formatTrackDuration, trackDurationSeconds } from "../data/trackDuration";
import { matchesTrackSearch } from "../data/trackSearch";
import Icon from "./Icon";
import TrackFilterControls from "./TrackFilterControls";

function OverflowTrackTitle({ children, active }) {
  const viewportRef = useRef(null);
  const titleRef = useRef(null);
  const motionAllowed = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const marqueeActive = active && motionAllowed;

  useEffect(() => {
    if (!marqueeActive) return undefined;
    const viewport = viewportRef.current;
    const title = titleRef.current;
    if (!viewport || !title) return undefined;

    let animation;
    let measuredWidth = -1;
    const updateAnimation = () => {
      const viewportWidth = viewport.clientWidth;
      if (viewportWidth === measuredWidth) return;
      measuredWidth = viewportWidth;
      animation?.cancel();
      const distance = Math.ceil(title.scrollWidth - viewportWidth);
      if (distance <= 1) return;

      const travelMs = Math.max(2200, (distance / 18) * 1000);
      const totalMs = travelMs + 1000;
      animation = title.animate([
        { transform: "translateX(0)", offset: 0 },
        { transform: `translateX(-${distance}px)`, offset: travelMs / totalMs },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ], {
        duration: totalMs,
        iterations: Infinity,
        easing: "linear",
      });
    };
    updateAnimation();
    const observer = new ResizeObserver(updateAnimation);
    observer.observe(viewport);

    return () => { observer.disconnect(); animation?.cancel(); };
  }, [marqueeActive, children]);

  return (
    <span className="track-browser__title-viewport" ref={viewportRef}>
      <strong ref={titleRef} className={marqueeActive ? "is-marquee-active" : ""}>{children}</strong>
    </span>
  );
}

export default function TrackList({
  tracks,
  selectedTrack,
  playingTrack,
  hasLoadedTrack,
  queuedTrack,
  queuedTrackProgress = null,
  undoEffect,
  disabled,
  sortMode = "alpha-asc",
  onChangeSort,
  getTrackAssets,
  filters,
  onChangeFilters,
  pinned,
  names,
  onPlay,
  onPlayAfterEnding,
  onPlayAfterStopping,
  onLoadAfterEnding,
  onLoadAfterStopping,
  onAddToQueue,
  onCollapse,
  onNavigateToControls,
}) {
  const [menuTrack, setMenuTrack] = useState(null);
  const [menuAction, setMenuAction] = useState(null);
  const [hoveredTrack, setHoveredTrack] = useState(null);
  const [heldTrack, setHeldTrack] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [durations, setDurations] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const filterButtonRef = useRef(null);
  const searchInputRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const pointerGestureRef = useRef(null);
  const menuOpenTimerRef = useRef(null);
  const menuCollapseTimerRef = useRef(null);

  const clearMenuTimers = () => {
    clearTimeout(menuOpenTimerRef.current);
    clearTimeout(menuCollapseTimerRef.current);
  };

  const openMenuAction = (action) => {
    clearMenuTimers();
    setMenuAction(action);
  };

  const startMenuHover = (event, action) => {
    if (event.pointerType !== "mouse") return;
    clearMenuTimers();
    menuOpenTimerRef.current = setTimeout(() => setMenuAction(action), 450);
  };

  useEffect(() => {
    if (!getTrackAssets) return undefined;
    let active = true;
    Promise.all(Object.entries(tracks || {}).map(async ([name, track]) => {
      try {
        const assets = await getTrackAssets(name);
        return [name, trackDurationSeconds(track, assets.clips)];
      } catch {
        return [name, null];
      }
    })).then((entries) => {
      if (active) setDurations(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [tracks, getTrackAssets]);

  const { orderedNames, visibleCount, filteredResultCount } = useMemo(() => {
    const filteredNames = orderTracks(tracks, { sortMode, filters, pinned, names, durations });
    if (!searchQuery.trim()) {
      return { orderedNames: filteredNames, visibleCount: filteredNames.length, filteredResultCount: 0 };
    }

    const matchesSearch = (name) => matchesTrackSearch(searchQuery, trackTitle(name, tracks[name], names), name);
    const visibleNames = filteredNames.filter(matchesSearch);
    const visibleSet = new Set(filteredNames);
    const filteredResultNames = orderTracks(tracks, {
      sortMode, filters: DEFAULT_TRACK_FILTERS, pinned, names, durations,
    }).filter((name) => !visibleSet.has(name) && matchesSearch(name));

    return {
      orderedNames: [...visibleNames, ...filteredResultNames],
      visibleCount: visibleNames.length,
      filteredResultCount: filteredResultNames.length,
    };
  }, [tracks, sortMode, filters, pinned, names, searchQuery, durations]);

  const titleFor = (name) => trackTitle(name, tracks[name], names);

  useEffect(() => {
    if (!menuTrack) return undefined;
    const closeMenu = (event) => {
      if (!event.target.closest(".track-browser__menu-wrap")) {
        clearMenuTimers();
        setMenuTrack(null);
        setMenuAction(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      clearMenuTimers();
    };
  }, [menuTrack]);

  useEffect(() => () => {
    clearTimeout(longPressTimerRef.current);
    clearMenuTimers();
  }, []);

  const runAction = (action, name, { navigate = true } = {}) => {
    clearMenuTimers();
    action?.(name);
    setMenuTrack(null);
    setMenuAction(null);
    if (navigate) onNavigateToControls?.();
  };

  const startLongPress = (event, name) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    clearTimeout(longPressTimerRef.current);
    pointerGestureRef.current = {
      name,
      x: event.clientX,
      y: event.clientY,
      canceled: false,
      longPress: false,
    };
    longPressTimerRef.current = setTimeout(() => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.name !== name || gesture.canceled) return;
      gesture.longPress = true;
      setHeldTrack(name);
    }, 500);
  };

  const updateLongPress = (event, name) => {
    const gesture = pointerGestureRef.current;
    if (!gesture || gesture.name !== name || gesture.longPress) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 10) {
      gesture.canceled = true;
      clearTimeout(longPressTimerRef.current);
    }
  };

  const finishPointer = (event, name) => {
    const gesture = pointerGestureRef.current;
    clearTimeout(longPressTimerRef.current);
    pointerGestureRef.current = null;
    setHeldTrack(null);
    if (gesture?.name === name && (event.pointerType === "touch" || event.pointerType === "pen")
        && !gesture?.longPress && !gesture?.canceled) {
      runAction(onPlay, name);
    }
  };

  const cancelLongPress = () => {
    clearTimeout(longPressTimerRef.current);
    pointerGestureRef.current = null;
    setHeldTrack(null);
  };

  return (
    <section className="track-library" aria-label="Track library">
      <div className="track-library__heading">
        <span className="track-library__heading-copy">
          <Icon name="library" size={18} />
          <strong>Track Library</strong>
          <small>{orderedNames.length}</small>
        </span>
        <button type="button" className="track-library__collapse" onClick={onCollapse} aria-label="Collapse track library" title="Collapse track library">
          <Icon name="chevronLeft" size={18} />
        </button>
      </div>
      <div className={`track-browser__toolbar ${searchExpanded ? "is-search-expanded" : ""}`}>
        <div className="track-browser__search" onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSearchExpanded(false);
        }}>
          <button
            type="button"
            className="track-browser__search-icon"
            aria-label={searchExpanded ? "Finish search" : "Focus track search"}
            title={searchExpanded ? "Finish search" : "Search tracks"}
            onClick={() => {
              if (searchExpanded) {
                setSearchExpanded(false);
                searchInputRef.current?.blur();
              } else searchInputRef.current?.focus();
            }}
          >
            <Icon name="search" size={16} />
          </button>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            placeholder="Search tracks"
            aria-label="Search tracks"
            enterKeyHint="search"
            onFocus={() => {
              setFiltersOpen(false);
              setSearchExpanded(true);
            }}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                event.preventDefault();
                setSearchExpanded(false);
                searchInputRef.current?.blur();
              }
            }}
          />
          {searchQuery && <button type="button" className="track-browser__search-clear" aria-label="Clear track search" title="Clear search" onClick={() => {
            setSearchQuery("");
            searchInputRef.current?.focus();
          }}><Icon name="close" size={14} /></button>}
        </div>
        <button
          ref={filterButtonRef}
          type="button"
          className="track-browser__filter-button"
          aria-label="Filters"
          title="Filters"
          aria-expanded={filtersOpen}
          aria-controls="library-filters"
          onClick={() => {
            setFiltersOpen(value => !value);
          }}
        >
          <Icon name="filter" size={16} />
          {activeTrackFilterCount(filters) > 0 && <span className="track-browser__filter-count">{activeTrackFilterCount(filters)}</span>}
        </button>
      </div>
      {filtersOpen && <TrackFilterControls
        id="library-filters"
        filters={filters}
        onChange={onChangeFilters}
        shownCount={orderedNames.length}
        totalCount={Object.keys(tracks || {}).length}
        onEscape={() => { setFiltersOpen(false); filterButtonRef.current?.focus(); }}
      />}
      <div className="track-browser__list">
      <div className="track-browser__columns" role="group" aria-label="Sort track library">
        <button type="button" className={sortMode.startsWith("alpha-") ? "is-active" : ""}
          aria-label={`Sort by title, ${sortMode === "alpha-asc" ? "Z to A" : "A to Z"}`}
          aria-pressed={sortMode.startsWith("alpha-")}
          onClick={() => onChangeSort?.(sortMode === "alpha-asc" ? "alpha-desc" : "alpha-asc")}>
          Title {sortMode.startsWith("alpha-") && <span className="track-browser__sort-arrow" aria-hidden="true">{sortMode === "alpha-asc" ? "▼" : "▲"}</span>}
        </button>
        <button type="button" className={sortMode.startsWith("duration-") ? "is-active" : ""}
          aria-label={`Sort by duration, ${sortMode === "duration-asc" ? "longest first" : "shortest first"}`}
          aria-pressed={sortMode.startsWith("duration-")}
          title="Duration"
          onClick={() => onChangeSort?.(sortMode === "duration-asc" ? "duration-desc" : "duration-asc")}>
          <Icon name="clock" size={15} />
          {sortMode.startsWith("duration-") && <span className="track-browser__sort-arrow" aria-hidden="true">{sortMode === "duration-asc" ? "▼" : "▲"}</span>}
        </button>
      </div>
            {orderedNames.length === 0 && <p className="track-browser__empty" role="status">{searchQuery.trim() ? "No tracks match this search." : "No tracks match these filters. Change them in Library Filters."}</p>}
            {orderedNames.map((name, index) => {
              const track = tracks[name];
              const isFilteredResult = index >= visibleCount;
              const isPlaying = playingTrack === name;
              const isQueued = queuedTrack === name;
              const tags = [
                pinned?.has(name) && "Pinned",
                track?.test && "Test",
                track?.simple === false && "Dynamic",
              ].filter(Boolean);

              return (
                <Fragment key={name}>
                {isFilteredResult && index === visibleCount && (
                  <p className="track-browser__filtered-heading">
                    Outside current filters · {filteredResultCount} {filteredResultCount === 1 ? "track" : "tracks"}
                  </p>
                )}
                <div
                  className={`track-browser__row ${selectedTrack === name ? "is-selected" : ""} ${isPlaying ? "is-playing" : ""} ${isQueued ? "is-queued" : ""} ${undoEffect?.kind === "track" && undoEffect?.next === name ? "is-undoing" : ""}`}
                  onPointerEnter={(event) => { if (event.pointerType === "mouse") setHoveredTrack(name); }}
                  onPointerLeave={(event) => { if (event.pointerType === "mouse") setHoveredTrack(null); }}
                >
                  <button
                    type="button"
                    className="track-browser__quick-action"
                    disabled={disabled}
                    onClick={() => runAction(onPlay, name)}
                    aria-label={`Play ${titleFor(name)}`}
                    title="Play track"
                  >
                    <Icon name="play" size={16} />
                  </button>
                  <button
                    type="button"
                    className="track-browser__track"
                    disabled={disabled}
                    onPointerDown={(event) => startLongPress(event, name)}
                    onPointerMove={(event) => updateLongPress(event, name)}
                    onPointerUp={(event) => finishPointer(event, name)}
                    onPointerCancel={cancelLongPress}
                    onContextMenu={(event) => { if (heldTrack === name) event.preventDefault(); }}
                    onDoubleClick={() => runAction(onPlay, name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        runAction(onPlay, name);
                      }
                    }}
                    title="Double-click to play"
                  >
                    <span className="track-browser__track-copy">
                      <OverflowTrackTitle active={hoveredTrack === name || heldTrack === name}>{titleFor(name)}</OverflowTrackTitle>
                      {tags.length > 0 && <small>{tags.join(" · ")}</small>}
                    </span>
                    <span className="track-browser__state">
                      {isPlaying && <span>Playing</span>}
                      {isQueued && <span>Queued</span>}
                    </span>
                    <span className={`track-browser__duration ${track?.simple === false ? "is-dynamic" : ""}`}
                      title={track?.simple === false ? "Sum of each clip’s loop point; actual playback may vary" : "Track duration"}>
                      {formatTrackDuration(durations[name])}
                    </span>
                  </button>

                  <div className="track-browser__menu-wrap">
                    <button
                      type="button"
                      className="track-browser__kebab"
                      disabled={disabled}
                      onClick={() => {
                        clearMenuTimers();
                        setMenuTrack(current => current === name ? null : name);
                        setMenuAction(null);
                      }}
                      aria-label={`Actions for ${titleFor(name)}`}
                      aria-expanded={menuTrack === name}
                    >
                      <Icon name="moreVertical" size={18} />
                    </button>
                    {menuTrack === name && (
                      <div className="track-browser__menu" role="menu" aria-label={`Actions for ${titleFor(name)}`}
                        onPointerEnter={(event) => { if (event.pointerType === "mouse") clearTimeout(menuCollapseTimerRef.current); }}
                        onPointerLeave={(event) => {
                          if (event.pointerType !== "mouse") return;
                          clearTimeout(menuOpenTimerRef.current);
                          if (menuAction) {
                            clearTimeout(menuCollapseTimerRef.current);
                            menuCollapseTimerRef.current = setTimeout(() => setMenuAction(null), 350);
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            clearMenuTimers();
                            if (menuAction) setMenuAction(null);
                            else setMenuTrack(null);
                          }
                        }}>
                        {!hasLoadedTrack ? (
                          <>
                            <button type="button" role="menuitem" onClick={() => runAction(onPlay, name)}>Play</button>
                            <button type="button" role="menuitem" onClick={() => runAction(onAddToQueue, name, { navigate: false })}>Add to queue</button>
                          </>
                        ) : menuAction ? (
                          <>
                            <button type="button" role="menuitem" className="track-browser__menu-back" onClick={() => openMenuAction(null)}><Icon name="chevronLeft" size={14} /> Back</button>
                            <button type="button" role="menuitem" onClick={() => runAction(menuAction === "play" ? onPlayAfterEnding : onLoadAfterEnding, name)}>{menuAction === "play" ? "Play" : "Load"} after ending/stopping current track</button>
                            <button type="button" role="menuitem" onClick={() => runAction(menuAction === "play" ? onPlayAfterStopping : onLoadAfterStopping, name)}>{menuAction === "play" ? "Play" : "Load"} after stopping current track</button>
                          </>
                        ) : (
                          <>
                            <button type="button" role="menuitem" className="track-browser__menu-next" onPointerEnter={(event) => startMenuHover(event, "play")} onPointerLeave={() => clearTimeout(menuOpenTimerRef.current)} onClick={() => openMenuAction("play")}>Play <Icon name="chevronRight" size={14} /></button>
                            <button type="button" role="menuitem" className="track-browser__menu-next" onPointerEnter={(event) => startMenuHover(event, "load")} onPointerLeave={() => clearTimeout(menuOpenTimerRef.current)} onClick={() => openMenuAction("load")}>Load <Icon name="chevronRight" size={14} /></button>
                            <button type="button" role="menuitem" onClick={() => runAction(onAddToQueue, name, { navigate: false })}>Add to queue</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {isQueued && queuedTrackProgress != null && (
                    <span className="track-browser__queue-progress" aria-hidden="true">
                      <span style={{ transform: `scaleX(${queuedTrackProgress})` }} />
                    </span>
                  )}
                </div>
                </Fragment>
              );
            })}
          </div>
    </section>
  );
}
