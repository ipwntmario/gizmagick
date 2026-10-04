import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { activeTrackFilterCount, DEFAULT_TRACK_FILTERS, orderTracks, trackTitle } from "../data/trackOrdering";
import { formatTrackDuration, trackDurationSeconds } from "../data/trackDuration";
import { matchesTrackSearch } from "../data/trackSearch";
import Icon from "./Icon";
import TrackFilterControls from "./TrackFilterControls";

const TRACK_LONG_PRESS_MS = 350;

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
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const [sheetInteracted, setSheetInteracted] = useState(false);
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
  const menuTriggerRef = useRef(null);
  const sheetRef = useRef(null);
  const sheetGestureRef = useRef(null);
  const sheetDraggedRef = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const clearMenuTimers = () => {
    clearTimeout(menuOpenTimerRef.current);
    clearTimeout(menuCollapseTimerRef.current);
  };

  const openMenuAction = (action) => {
    clearMenuTimers();
    setMenuAction(action);
  };

  const startMenuHover = (event, action) => {
    if (isMobile || event.pointerType !== "mouse") return;
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
    if (!menuTrack || isMobile) return undefined;
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
  }, [menuTrack, isMobile]);

  useEffect(() => {
    if (!menuTrack || !isMobile) return undefined;
    sheetRef.current?.querySelector(".track-browser__sheet-actions button")?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenuTrack(null);
        setMenuAction(null);
        menuTriggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuTrack, isMobile]);

  useEffect(() => () => {
    clearTimeout(longPressTimerRef.current);
    clearMenuTimers();
  }, []);

  const runAction = (action, name, { navigate = true } = {}) => {
    clearMenuTimers();
    action?.(name);
    setMenuTrack(null);
    setMenuAction(null);
    if (!navigate && isMobile) menuTriggerRef.current?.focus();
    if (navigate) onNavigateToControls?.();
  };

  const dismissSheet = () => {
    clearMenuTimers();
    setMenuTrack(null);
    setMenuAction(null);
    setSheetOffset(0);
    setSheetDragging(false);
    setSheetInteracted(false);
    menuTriggerRef.current?.focus();
  };

  const onSheetPointerDown = (event) => {
    if (event.pointerType === "mouse" && !event.target.closest(".track-browser__sheet-handle")) return;
    sheetGestureRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  };

  const onSheetPointerMove = (event) => {
    const gesture = sheetGestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - gesture.y;
    if (!gesture.dragging && (deltaY < 8 || deltaY < Math.abs(event.clientX - gesture.x))) return;
    if (!gesture.dragging) {
      gesture.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setSheetDragging(true);
    setSheetInteracted(true);
    gesture.offset = Math.max(0, deltaY);
    setSheetOffset(gesture.offset);
  };

  const onSheetPointerUp = () => {
    const gesture = sheetGestureRef.current;
    sheetGestureRef.current = null;
    if (!gesture?.dragging) return;
    sheetDraggedRef.current = true;
    window.setTimeout(() => { sheetDraggedRef.current = false; }, 300);
    if (gesture.offset > 90) dismissSheet();
    else { setSheetOffset(0); setSheetDragging(false); }
  };

  const onSheetPointerCancel = () => {
    sheetGestureRef.current = null;
    setSheetOffset(0);
    setSheetDragging(false);
  };

  const openTrackMenu = (name, trigger) => {
    menuTriggerRef.current = trigger;
    sheetDraggedRef.current = false;
    setSheetOffset(0);
    setSheetInteracted(false);
    setMenuAction(null);
    setMenuTrack(name);
  };

  const startLongPress = (event, name) => {
    if (!isMobile || (event.pointerType !== "touch" && event.pointerType !== "pen")) return;
    clearTimeout(longPressTimerRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    menuTriggerRef.current = event.currentTarget;
    pointerGestureRef.current = {
      name,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      canceled: false,
      longPress: false,
    };
    longPressTimerRef.current = setTimeout(() => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.name !== name || gesture.canceled) return;
      gesture.longPress = true;
      setHeldTrack(name);
      openTrackMenu(name, menuTriggerRef.current);
    }, TRACK_LONG_PRESS_MS);
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
    if (gesture?.name === name && (event.pointerType === "touch" || event.pointerType === "pen") && !gesture.canceled) {
      if (gesture.longPress) return;
      if (performance.now() - gesture.startedAt >= TRACK_LONG_PRESS_MS) openTrackMenu(name, event.currentTarget);
      else runAction(onPlay, name);
    }
  };

  const onTrackContextMenu = (event, name) => {
    if (!isMobile) return;
    event.preventDefault();
    clearTimeout(longPressTimerRef.current);
    const gesture = pointerGestureRef.current;
    if (gesture?.name === name && gesture.canceled) return;
    if (gesture?.name === name) {
      gesture.longPress = true;
      setHeldTrack(name);
    }
    openTrackMenu(name, event.currentTarget);
  };

  const cancelLongPress = () => {
    clearTimeout(longPressTimerRef.current);
    pointerGestureRef.current = null;
    setHeldTrack(null);
  };

  const renderMenuItems = (name, mobile = false) => {
    const itemRole = mobile ? undefined : "menuitem";
    if (!hasLoadedTrack) return <>
      <button type="button" role={itemRole} onClick={() => runAction(onPlay, name)}>Play</button>
      <button type="button" role={itemRole} onClick={() => runAction(onAddToQueue, name, { navigate: false })}>Add to queue</button>
    </>;
    if (menuAction) return <>
      <button type="button" role={itemRole} className="track-browser__menu-back" onClick={() => openMenuAction(null)}><Icon name="chevronLeft" size={14} /> Back</button>
      <button type="button" role={itemRole} onClick={() => runAction(menuAction === "play" ? onPlayAfterEnding : onLoadAfterEnding, name)}>{menuAction === "play" ? "Play" : "Load"} after ending/stopping current track</button>
      <button type="button" role={itemRole} onClick={() => runAction(menuAction === "play" ? onPlayAfterStopping : onLoadAfterStopping, name)}>{menuAction === "play" ? "Play" : "Load"} after stopping current track</button>
    </>;
    return <>
      <button type="button" role={itemRole} className="track-browser__menu-next" onPointerEnter={(event) => startMenuHover(event, "play")} onPointerLeave={() => clearTimeout(menuOpenTimerRef.current)} onClick={() => openMenuAction("play")}>Play <Icon name="chevronRight" size={14} /></button>
      <button type="button" role={itemRole} className="track-browser__menu-next" onPointerEnter={(event) => startMenuHover(event, "load")} onPointerLeave={() => clearTimeout(menuOpenTimerRef.current)} onClick={() => openMenuAction("load")}>Load <Icon name="chevronRight" size={14} /></button>
      <button type="button" role={itemRole} onClick={() => runAction(onAddToQueue, name, { navigate: false })}>Add to queue</button>
    </>;
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
                    onContextMenu={(event) => onTrackContextMenu(event, name)}
                    onSelectStart={(event) => { if (isMobile) event.preventDefault(); }}
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
                      title={track?.simple === false ? "Sum of each clip and mode variant’s loop point; actual playback may vary" : "Track duration"}>
                      {track?.simple === false && durations[name] != null && <span className="track-browser__duration-sum" aria-hidden="true">∑</span>}
                      {formatTrackDuration(durations[name])}
                    </span>
                  </button>

                  <div className="track-browser__menu-wrap">
                    <button
                      type="button"
                      className="track-browser__kebab"
                      disabled={disabled}
                      onClick={(event) => {
                        clearMenuTimers();
                        menuTriggerRef.current = event.currentTarget;
                        sheetDraggedRef.current = false;
                        setSheetOffset(0);
                        setSheetInteracted(false);
                        setMenuTrack(current => current === name ? null : name);
                        setMenuAction(null);
                      }}
                      aria-label={`Actions for ${titleFor(name)}`}
                      aria-expanded={menuTrack === name}
                    >
                      <Icon name="moreVertical" size={18} />
                    </button>
                    {menuTrack === name && !isMobile && (
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
                        {renderMenuItems(name)}
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
      {menuTrack && isMobile && createPortal(
        <div className="track-browser__sheet-layer" onContextMenu={(event) => event.preventDefault()}>
          <div className="track-browser__sheet-backdrop" aria-hidden="true" onClick={dismissSheet} />
          <div className={`track-browser__sheet ${sheetDragging ? "is-dragging" : ""} ${sheetInteracted ? "has-dragged" : ""}`} role="dialog" aria-modal="true" aria-label={`Actions for ${titleFor(menuTrack)}`}
            ref={sheetRef}
            style={sheetOffset ? { transform: `translateY(${sheetOffset}px)` } : undefined}
            onPointerDown={onSheetPointerDown}
            onPointerMove={onSheetPointerMove}
            onPointerUp={onSheetPointerUp}
            onPointerCancel={onSheetPointerCancel}
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const buttons = [...event.currentTarget.querySelectorAll("button")];
              if (!buttons.length) return;
              if (event.shiftKey && document.activeElement === buttons[0]) {
                event.preventDefault();
                buttons.at(-1).focus();
              } else if (!event.shiftKey && document.activeElement === buttons.at(-1)) {
                event.preventDefault();
                buttons[0].focus();
              }
            }}
            onClickCapture={(event) => {
              if (!sheetDraggedRef.current) return;
              event.preventDefault();
              event.stopPropagation();
            }}>
            <div className="track-browser__sheet-handle" aria-hidden="true"><span /></div>
            <div className="track-browser__sheet-heading">
              <div><small>Track actions</small><strong>{titleFor(menuTrack)}</strong></div>
            </div>
            <div className="track-browser__sheet-actions">{renderMenuItems(menuTrack, true)}</div>
          </div>
        </div>, document.body
      )}
    </section>
  );
}
