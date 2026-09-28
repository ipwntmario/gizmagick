import { useEffect, useMemo, useRef, useState } from "react";
import { activeTrackFilterCount, orderTracks, trackTitle } from "../data/trackOrdering";
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
  const [sortOpen, setSortOpen] = useState(false);
  const filterButtonRef = useRef(null);
  const sortButtonRef = useRef(null);
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

  const orderedNames = useMemo(() => orderTracks(tracks, {
    sortMode, filters, pinned, names,
  }), [tracks, sortMode, filters, pinned, names]);

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
      <div className="track-browser__toolbar">
        <button
          ref={filterButtonRef}
          type="button"
          className="track-browser__filter-button"
          aria-expanded={filtersOpen}
          aria-controls="library-filters"
          onClick={() => {
            setSortOpen(false);
            setFiltersOpen(value => !value);
          }}
        >
          <Icon name="filter" size={16} />
          <span>Filters</span>
          {activeTrackFilterCount(filters) > 0 && <span className="track-browser__filter-count">{activeTrackFilterCount(filters)}</span>}
        </button>
        <button
          ref={sortButtonRef}
          type="button"
          className="track-browser__sort-button"
          aria-expanded={sortOpen}
          aria-controls="library-sort"
          onClick={() => {
            setFiltersOpen(false);
            setSortOpen(value => !value);
          }}
        >
          <Icon name="sort" size={16} />
          <span>Sort</span>
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
      {sortOpen && (
        <div
          className="track-sort"
          id="library-sort"
          role="group"
          aria-label="Sort tracks"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setSortOpen(false);
              sortButtonRef.current?.focus();
            }
          }}
        >
          {[["alpha-asc", "A to Z"], ["alpha-desc", "Z to A"]].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={sortMode === value ? "is-active" : ""}
              aria-pressed={sortMode === value}
              onClick={() => {
                onChangeSort?.(value);
                setSortOpen(false);
                sortButtonRef.current?.focus();
              }}
            >
              <Icon name="sort" size={15} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
          <div className="track-browser__list">
            {orderedNames.length === 0 && <p className="track-browser__empty" role="status">No tracks match these filters. Change them in Library Filters.</p>}
            {orderedNames.map((name) => {
              const track = tracks[name];
              const isPlaying = playingTrack === name;
              const isQueued = queuedTrack === name;
              const tags = [
                pinned?.has(name) && "Pinned",
                track?.test && "Test",
                track?.simple === false && "Dynamic",
              ].filter(Boolean);

              return (
                <div
                  className={`track-browser__row ${selectedTrack === name ? "is-selected" : ""} ${isPlaying ? "is-playing" : ""} ${isQueued ? "is-queued" : ""} ${undoEffect?.kind === "track" && undoEffect?.next === name ? "is-undoing" : ""}`}
                  key={name}
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
              );
            })}
          </div>
    </section>
  );
}
