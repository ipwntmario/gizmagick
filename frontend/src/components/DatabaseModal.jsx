import { activeTrackFilterCount, DEFAULT_TRACK_FILTERS, orderTracks, trackTitle } from "../data/trackOrdering";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "./Icon";
import TrackFilterControls from "./TrackFilterControls";

/** Helper: consider a track "dynamic" when simple === false */
const isDynamic = (t) => t?.simple === false;
/** Helper: consider a track a "test" when test === true (you can set in trackData.json) */
const isTest = (name, t) => t?.test === true;

export default function DatabaseModal({
  open,
  onClose,
  tracks, // { [trackName]: { defaultDisplayName, basePath, simple, test?, ... } }
  // Controlled prefs
  sortMode = "alpha-asc",     // "alpha-asc" | "alpha-desc"
  onChangeSort,
  pinned,                     // Set<string>
  onTogglePin,                // (name) => void
  onApplyRename,
  names,
}) {
  const [expandedTracks, setExpandedTracks] = useState(() => new Set());
  const [expandedSections, setExpandedSections] = useState(() => new Set()); // keys: `${track}::${sectionKey}`
  const [sectionsByTrack, setSectionsByTrack] = useState({});               // cache: { trackName: { sections } }
  const [loadingTrack, setLoadingTrack] = useState(null);
  const [trackMenuOpen, setTrackMenuOpen] = useState(null);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const [sheetInteracted, setSheetInteracted] = useState(false);
  const menuTriggerRef = useRef(null);
  const sheetRef = useRef(null);
  const sheetGestureRef = useRef(null);
  const sheetDraggedRef = useRef(false);
  const trackHoldRef = useRef(null);
  const suppressTrackClickRef = useRef(false);
  const [filters, setFilters] = useState(() => ({ ...DEFAULT_TRACK_FILTERS }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filterButtonRef = useRef(null);
  const sortButtonRef = useRef(null);
  const activeFilterCount = activeTrackFilterCount(filters);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setIsMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!trackMenuOpen || isMobile) return;
    const closeMenu = (event) => {
      if (!event.target.closest(".database-track-actions")) setTrackMenuOpen(null);
    };
    document.addEventListener("pointerdown", closeMenu);
    return () => document.removeEventListener("pointerdown", closeMenu);
  }, [trackMenuOpen, isMobile]);

  useEffect(() => {
    if (!trackMenuOpen || !isMobile) return undefined;
    sheetRef.current?.querySelector(".track-browser__sheet-actions button")?.focus();
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setTrackMenuOpen(null);
      menuTriggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [trackMenuOpen, isMobile]);

  const dismissSheet = () => {
    setTrackMenuOpen(null);
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

  const cancelTrackHold = () => {
    if (trackHoldRef.current?.timer) window.clearTimeout(trackHoldRef.current.timer);
    trackHoldRef.current = null;
  };

  const onTrackPointerDown = (event, trackName) => {
    if (!isMobile || event.pointerType === "mouse" || event.target.closest("button")) return;
    cancelTrackHold();
    const row = event.currentTarget;
    const hold = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    hold.timer = window.setTimeout(() => {
      if (trackHoldRef.current !== hold) return;
      suppressTrackClickRef.current = true;
      menuTriggerRef.current = row.querySelector(".database-track-menu-button");
      setSheetOffset(0);
      setSheetInteracted(false);
      setTrackMenuOpen(trackName);
      navigator.vibrate?.(12);
      window.setTimeout(() => { suppressTrackClickRef.current = false; }, 800);
    }, 500);
    trackHoldRef.current = hold;
  };

  const onTrackPointerMove = (event) => {
    const hold = trackHoldRef.current;
    if (hold?.pointerId === event.pointerId && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 10) cancelTrackHold();
  };

  // Rename modal state
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState(null); // { type: 'track'|'section'|'mode', trackName, sectionKey?, modeName?, isBase? }
  const [renameFields, setRenameFields] = useState({});   // { name, button } depends on type
  const [renameDefaults, setRenameDefaults] = useState({}); // { nameDefault, buttonDefault }

  // Rename reading
  const titleForTrack = (name, t) =>
    trackTitle(name, t, names);

  // Clicking outside of modal functionality
  const overlayRef = useRef(null);
  const overlayMouseDownRef = useRef(false);

  const handleOverlayMouseDown = (e) => {
    // only arm close if the press started on the overlay itself
    overlayMouseDownRef.current = (e.target === overlayRef.current);
  };
  const handleOverlayMouseUp = (e) => {
    // close only if both down and up happened on the overlay
    if (e.target === overlayRef.current && overlayMouseDownRef.current) {
      onClose?.();
    }
    overlayMouseDownRef.current = false;
  };

  const sortedTrackNames = useMemo(() => orderTracks(tracks, {
    sortMode, filters, pinned, names,
  }), [tracks, sortMode, filters, pinned, names]);

  const fetchSectionsIfNeeded = async (trackName) => {
    if (sectionsByTrack[trackName]) return sectionsByTrack[trackName];
    try {
      setLoadingTrack(trackName);
      const basePath = tracks[trackName]?.basePath || `/tracks/${trackName}`;
      const res = await fetch(`${basePath}/sectionData.json`);
      if (!res.ok) throw new Error(`Failed to load sections: ${res.status}`);
      const json = await res.json();
      const sections = json?.sections || json || {};
      setSectionsByTrack((prev) => ({ ...prev, [trackName]: sections }));
      return sections;
    } catch (e) {
      console.error("Failed to load sectionData for", trackName, e);
    } finally {
      setLoadingTrack(null);
    }
  };

  const toggleTrack = async (trackName) => {
    const next = new Set(expandedTracks);
    if (next.has(trackName)) {
      next.delete(trackName);
      setExpandedTracks(next);
      return;
    }
    await fetchSectionsIfNeeded(trackName);
    next.add(trackName);
    setExpandedTracks(next);
  };

  const toggleSection = (trackName, sectionKey) => {
    const key = `${trackName}::${sectionKey}`;
    const next = new Set(expandedSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExpandedSections(next);
  };

  const expandAll = async () => {
    // expand all tracks (and load each if needed), then all sections
    const loaded = await Promise.all(sortedTrackNames.map(async name => [name, await fetchSectionsIfNeeded(name)]));
    setExpandedTracks(new Set(sortedTrackNames));
    const allSectionKeys = loaded.flatMap(([name, sections]) => Object.keys(sections || {}).map(key => `${name}::${key}`));
    setExpandedSections(new Set(allSectionKeys));
  };

  const collapseAll = () => {
    setExpandedTracks(new Set());
    setExpandedSections(new Set());
  };

  // --- Rename helpers ---
  const openRenameForTrack = (trackName) => {
    const t = tracks[trackName];
    const nameDefault = t?.defaultDisplayName || trackName;
    // current = override OR default
    const nameCurrent = names?.tracks?.[trackName]?.displayName ?? nameDefault;
    setRenameDefaults({ nameDefault });
    setRenameFields({ name: nameCurrent });
    setRenameOpen(true);
    setRenameTarget({ type: "track", trackName, defaults: { nameDefault }});
  };

  const openRenameForSection = (trackName, sectionKey) => {
    const s = sectionsByTrack[trackName]?.[sectionKey] || {};
    const nameDefault = s?.defaultDisplayName || sectionKey;
    const buttonDefault = s?.defaultButtonName || "";
    // current = overrides OR defaults
    const secOverrides = names?.sections?.[trackName]?.[sectionKey] || {};
    const nameCurrent   = secOverrides.displayName ?? nameDefault;
    const buttonCurrent = (secOverrides.buttonName != null ? secOverrides.buttonName : buttonDefault);
    setRenameDefaults({ nameDefault, buttonDefault });
    setRenameFields({ name: nameCurrent, button: buttonCurrent });
    setRenameTarget({ type: "section", trackName, sectionKey, defaults: { nameDefault, buttonDefault }});
    setRenameOpen(true);
  };

  const openRenameForMode = (trackName, sectionKey, modeName, isBase) => {
    const s = sectionsByTrack[trackName]?.[sectionKey] || {};
    const nameDefault = isBase ? (s?.defaultBaseModeName || "base") : modeName;
    // current = override OR default
    const nameCurrent = isBase
      ? (names?.sections?.[trackName]?.[sectionKey]?.baseModeName ?? nameDefault)
      : (names?.modes?.[trackName]?.[sectionKey]?.[modeName]?.displayName ?? nameDefault);
    setRenameDefaults({ nameDefault });
    setRenameFields({ name: nameCurrent });
    setRenameTarget({ type: "mode", trackName, sectionKey, modeName, isBase: !!isBase, defaults: { nameDefault }});
    setRenameOpen(true);
  };

  const closeRename = () => {
    setRenameOpen(false);
    setRenameTarget(null);
    setRenameFields({});
    setRenameDefaults({});
  };

  const resetFieldToDefault = (field) => {
    if (!renameDefaults) return;
    setRenameFields((prev) => ({
      ...prev,
      [field]: renameDefaults[field + "Default"] ?? (field === "button" ? "" : "")
    }));
  };


  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
      className="database-overlay"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "flex-start",   // anchor at top
        justifyContent: "center",   // comfy breathing room at top
        paddingTop: "6vh",
        zIndex: 9999,
        overflowY: "auto"           // allow page to scroll if needed
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="database-modal"
        style={{
          width: 720, maxHeight: "84vh",
          background: "#2d2d2d", color: "white",
          borderRadius: 12, boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          display: "flex", flexDirection: "column"
        }}
      >
        {/* Sticky header */}
        <div className="database-modal__header" style={{
          position: "sticky", top: 0,
          background: "#2d2d2d", zIndex: 2,
          borderBottom: "1px solid #444", padding: 12,
          display: "flex", alignItems: "center", justifyContent: "space-between"
        }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18 }}>Database</h2>
            <p className="database-modal__subtitle">Manage tracks, sections, modes, and display names</p>
          </div>
          <button
            onClick={onClose}
            className="database-icon-button"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "white" }}
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Sticky controls bar */}
        <div className="database-toolbar" style={{
          position: "sticky", top: 48, // immediately under the header
          background: "#2d2d2d", zIndex: 1,
          borderBottom: "1px solid #444", padding: "8px 12px",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
        }}>
          <button
            ref={filterButtonRef}
            type="button"
            className="track-browser__filter-button database-toolbar__control"
            aria-expanded={filtersOpen}
            aria-controls="database-filters"
            onClick={() => {
              setSortOpen(false);
              setFiltersOpen(value => !value);
            }}
          >
            <Icon name="filter" size={16} />
            <span>Filters</span>
            {activeFilterCount > 0 && <span className="database-filter-count">{activeFilterCount}</span>}
          </button>
          <button
            ref={sortButtonRef}
            type="button"
            className="track-browser__sort-button database-toolbar__control"
            aria-expanded={sortOpen}
            aria-controls="database-sort"
            onClick={() => {
              setFiltersOpen(false);
              setSortOpen(value => !value);
            }}
          >
            <Icon name="sort" size={16} />
            <span>Sort</span>
          </button>

          <div className="database-toolbar__actions" style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              onClick={expandAll}
              className="database-button database-button--quiet"
              style={{ background: "transparent", border: "1px solid #555", borderRadius: 6, padding: "4px 8px", color: "white", cursor: "pointer" }}
            >
              expand all
            </button>
            <button
              onClick={collapseAll}
              className="database-button database-button--quiet"
              style={{ background: "transparent", border: "1px solid #555", borderRadius: 6, padding: "4px 8px", color: "white", cursor: "pointer" }}
            >
              collapse all
            </button>
          </div>
          {filtersOpen && <TrackFilterControls
            id="database-filters"
            filters={filters}
            onChange={setFilters}
            shownCount={sortedTrackNames.length}
            totalCount={Object.keys(tracks || {}).length}
            onEscape={() => {
                setFiltersOpen(false);
                filterButtonRef.current?.focus();
            }}
          />}
          {sortOpen && <div
            className="track-sort database-toolbar__sort-menu"
            id="database-sort"
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
          </div>}
        </div>

        {/* Scrollable body */}
        <div className="database-modal__body" style={{ overflow: "auto" }}>
          {/* Header row */}
          <div className="database-list-heading" style={{ display: "grid", gridTemplateColumns: "24px 1fr", padding: "6px 12px", borderBottom: "1px solid #444", color: "#bbb" }}>
            <div />
            <div>Name</div>
          </div>

          {/* Tracks */}
          <div>
            {sortedTrackNames.length === 0 && (
              <div className="database-empty" role="status">
                <p>No tracks match these filters.</p>
                <button type="button" className="database-button database-button--quiet" onClick={() => setFilters({ ...DEFAULT_TRACK_FILTERS })}>Show all tracks</button>
              </div>
            )}
            {sortedTrackNames.map((trackName) => {
              const t = tracks[trackName];
              const expanded = expandedTracks.has(trackName);
              const sections = sectionsByTrack[trackName];
              const dyn = isDynamic(t);
              const test = isTest(trackName, t);

              return (
                <div key={trackName}>
                  {/* Track row */}
                  <div
                    className={`database-row database-row--track ${expanded ? "is-expanded" : ""} ${trackMenuOpen === trackName ? "is-menu-open" : ""}`}
                    onPointerDown={(event) => onTrackPointerDown(event, trackName)}
                    onPointerMove={onTrackPointerMove}
                    onPointerUp={cancelTrackHold}
                    onPointerCancel={cancelTrackHold}
                    onContextMenu={(event) => { if (isMobile) event.preventDefault(); }}
                    onSelectStart={(event) => { if (isMobile) event.preventDefault(); }}
                    onClickCapture={(event) => {
                      if (!suppressTrackClickRef.current) return;
                      event.preventDefault();
                      event.stopPropagation();
                      suppressTrackClickRef.current = false;
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px 1fr 32px", // expand, label, actions
                      padding: "6px 12px",
                      borderBottom: "1px solid #3a3a3a",
                      alignItems: "center",
                      userSelect: "none"
                    }}
                  >
                    {/* +/- expand — borderless */}
                    <button
                      onClick={() => toggleTrack(trackName)}
                      className="database-expand"
                      style={{
                        width: 20, height: 20,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        background: "transparent",
                        border: "none",
                        color: "white",
                        borderRadius: 4,
                        fontSize: 12, lineHeight: 1, padding: 0,
                        cursor: "pointer"
                      }}
                      title={expanded ? "Collapse" : "Expand"}
                    >
                      {expanded ? "−" : "+"}
                    </button>

                    <div className="database-track-main">
                      {/* Label with pinned, test, and dynamic markers */}
                      <div
                        className="database-label database-label--track database-track-label"
                        onClick={() => toggleTrack(trackName)}
                        title="Click to expand or collapse"
                      >
                        <span style={{ display: "inline-flex", verticalAlign: "middle", gap: 4, marginRight: pinned?.has(trackName) || test || dyn ? 6 : 0 }}>
                          {pinned?.has(trackName) && <Icon name="pin" size={14} />}
                          {test && <Icon name="flask" size={14} />}
                          {dyn && <Icon name="diamond" size={14} />}
                        </span>
                        {titleForTrack(trackName, t)}
                      </div>

                      <div className="database-track-actions">
                        <button
                          type="button"
                          className="database-track-menu-button"
                          aria-label={`Actions for ${titleForTrack(trackName, t)}`}
                          aria-expanded={trackMenuOpen === trackName}
                          onClick={(event) => {
                            menuTriggerRef.current = event.currentTarget;
                            sheetDraggedRef.current = false;
                            setSheetOffset(0);
                            setSheetInteracted(false);
                            setTrackMenuOpen((current) => current === trackName ? null : trackName);
                          }}
                        >
                          <Icon name="moreVertical" size={19} />
                        </button>
                        {trackMenuOpen === trackName && !isMobile && (
                          <div className="database-track-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                onTogglePin?.(trackName);
                                setTrackMenuOpen(null);
                              }}
                            >
                              {pinned?.has(trackName) ? "Unpin" : "Pin"}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setTrackMenuOpen(null);
                                openRenameForTrack(trackName);
                              }}
                            >
                              Rename
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Sections */}
                  {expanded && (
                    <div>
                      {loadingTrack === trackName && (
                        <div className="database-loading" style={{ padding: "6px 12px", color: "#bbb" }}><span className="loading-indicator"><Icon name="loading" size={14} /></span> Loading sections…</div>
                      )}
                      {sections && Object.entries(sections).map(([sectionKey, s]) => {
                        const secKey = `${trackName}::${sectionKey}`;
                        const secExpanded = expandedSections.has(secKey);
                        const titleLabel  =
                          names?.sections?.[trackName]?.[sectionKey]?.displayName
                          ?? s?.defaultDisplayName
                          ?? sectionKey;
                        const buttonLabelOverride = names?.sections?.[trackName]?.[sectionKey]?.buttonName;
                        const buttonLabel = buttonLabelOverride != null && buttonLabelOverride !== ""
                          ? buttonLabelOverride
                          : (s?.defaultButtonName ?? undefined);
                        const sectionGray = t?.simple === true;

                        return (
                          <div key={sectionKey}>
                            {/* Section row: ↳ • +/- • label */}
                            <div
                              className="database-row database-row--section"
                              style={{
                                display: "grid",
                                gridTemplateColumns: "24px 24px 1fr", // arrow, expand, label
                                padding: "6px 12px 6px 36px",
                                borderBottom: "1px dashed #3a3a3a",
                                alignItems: "center",
                                color: sectionGray ? "#9a9a9a" : "inherit",
                                userSelect: "none"
                              }}
                            >
                              {/* ↳ to show hierarchy */}
                              <div style={{ textAlign: "center", opacity: 0.9 }}>
                                {/* ↳ */}
                              </div>

                              {/* expand */}
                              <button
                                onClick={() => toggleSection(trackName, sectionKey)}
                                className="database-expand"
                                style={{
                                  width: 20, height: 20,
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  background: "transparent",
                                  border: "none",
                                  color: "white",
                                  borderRadius: 4,
                                  fontSize: 12, lineHeight: 1, padding: 0,
                                  cursor: "pointer"
                                }}
                                title={secExpanded ? "Collapse" : "Expand"}
                              >
                                {secExpanded ? "−" : "+"}
                              </button>

                              {/* label (click/ dblclick) */}
                              <RenameableLabel
                                className="database-label database-label--section"
                                onPrimaryClick={() => toggleSection(trackName, sectionKey)}
                                onRename={() => openRenameForSection(trackName, sectionKey)}
                                title="Click to expand or collapse. Double-click, long-press, or use the pencil to rename."
                              >
                                <span style={{ fontWeight: 400 }}>{titleLabel}</span>
                                {buttonLabel && (
                                  <>
                                    <span style={{ color: "#9a9a9a" }}>{", button: "}</span>
                                    <span>{buttonLabel}</span>
                                  </>
                                )}
                              </RenameableLabel>
                            </div>

                            {/* Modes list (aligned) */}
                            {secExpanded && (
                              <ModeRows
                                trackName={trackName}
                                sectionKey={sectionKey}
                                section={s}
                                onRenameMode={openRenameForMode}
                                names={names}
                              />
                            )}
                          </div>
                        );
                      })}

                      {!loadingTrack && sections && Object.keys(sections).length === 0 && (
                        <div style={{ padding: "6px 12px 6px 36px", color: "#bbb" }}>
                          (No sections found)
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {trackMenuOpen && isMobile && createPortal(
        <div className="track-browser__sheet-layer database-track-sheet-layer" onContextMenu={(event) => event.preventDefault()}>
          <div className="track-browser__sheet-backdrop" aria-hidden="true" onClick={dismissSheet} />
          <div
            className={`track-browser__sheet ${sheetDragging ? "is-dragging" : ""} ${sheetInteracted ? "has-dragged" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={`Actions for ${titleForTrack(trackMenuOpen, tracks[trackMenuOpen])}`}
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
            }}
          >
            <div className="track-browser__sheet-handle" aria-hidden="true"><span /></div>
            <div className="track-browser__sheet-heading">
              <div><small>Track actions</small><strong>{titleForTrack(trackMenuOpen, tracks[trackMenuOpen])}</strong></div>
            </div>
            <div className="track-browser__sheet-actions">
              <button type="button" onClick={() => { onTogglePin?.(trackMenuOpen); dismissSheet(); }}>
                <Icon name="pin" size={17} />{pinned?.has(trackMenuOpen) ? "Unpin" : "Pin"}
              </button>
              <button type="button" onClick={() => { const name = trackMenuOpen; setTrackMenuOpen(null); openRenameForTrack(name); }}>
                <Icon name="pencil" size={17} />Rename
              </button>
            </div>
          </div>
        </div>, document.body
      )}

      {/* Rename modal */}
      {renameOpen && (
        <RenameModal
          target={renameTarget}
          fields={renameFields}
          defaults={renameDefaults}
          onChangeFields={setRenameFields}
          onResetField={resetFieldToDefault}
          onClose={closeRename}
          onSave={() => {
            // UI only for now
            onApplyRename?.(renameTarget, { ...renameFields });
            closeRename();
          }}
        />
      )}
    </div>
  );
}

function ModeRows({ trackName, sectionKey, section, onRenameMode, names }) {
  const raw = section?.modes;
  const modes = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const hasOnlyBase = modes.length === 0;
  const baseLabel = names?.sections?.[trackName]?.[sectionKey]?.baseModeName
    ?? section?.defaultBaseModeName
    ?? "base";

  // Base mode row first
  const rows = [
    {
      key: "__base__",
      label: hasOnlyBase ? "base" : `${baseLabel} `,
      isBase: true,
      // gray out if only base exists
      dim: hasOnlyBase
    },
    ...modes.map((m) => ({
      key: m,
      label: (names?.modes?.[trackName]?.[sectionKey]?.[m]?.displayName ?? m),
      isBase: false,
      dim: false
    }))
  ];

  return (
    <div>
      {rows.map((r, idx) => (
        <div
          key={r.key}
          className="database-row database-row--mode"
          style={{
            display: "grid",
            gridTemplateColumns: "24px 24px 1fr", // arrow, (no expand), label
            padding: "6px 12px 6px 52px", // indent a bit more than section
            borderBottom: idx === rows.length - 1 ? "none" : "1px solid #2a2a2a",
            alignItems: "center",
            userSelect: "none"
          }}
        >
          {/* ↳ for hierarchy */}
          <div style={{ textAlign: "center", opacity: 0.9 }}>
            {/* ↳ */}
          </div>
          {/* empty cell to align with expand button column */}
          <div />
          {/* label (dblclick to rename) */}
          <RenameableLabel
            className={`database-label database-label--mode ${r.dim ? "is-dimmed" : ""}`}
            onRename={() => onRenameMode(trackName, sectionKey, r.key === "__base__" ? "base" : r.key, r.isBase)}
            title="Double-click, long-press, or use the pencil to rename."
          >
            {r.isBase && !hasOnlyBase ? (
              <>
                {r.label}<span style={{ color: "#9a9a9a" }}>(base)</span>
              </>
            ) : (
              r.label
            )}
          </RenameableLabel>
        </div>
      ))}
    </div>
  );
}

const RENAME_LONG_PRESS_MS = 550;

function RenameableLabel({ children, className = "", onPrimaryClick, onRename, title }) {
  const pressTimer = useRef(null);
  const pressStart = useRef(null);
  const suppressClick = useRef(false);

  const clearPress = () => {
    clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  };

  return (
    <div
      className={`database-renameable ${className}`}
      title={title}
      onClick={() => {
        if (!suppressClick.current) onPrimaryClick?.();
      }}
      onDoubleClick={() => {
        if (window.matchMedia("(hover: hover)").matches) onRename?.();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") return;
        pressStart.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = setTimeout(() => {
          suppressClick.current = true;
          onRename?.();
          navigator.vibrate?.(12);
          setTimeout(() => { suppressClick.current = false; }, 700);
        }, RENAME_LONG_PRESS_MS);
      }}
      onPointerMove={(event) => {
        if (!pressStart.current) return;
        if (Math.hypot(event.clientX - pressStart.current.x, event.clientY - pressStart.current.y) > 10) clearPress();
      }}
      onPointerUp={() => {
        const didLongPress = suppressClick.current;
        clearPress();
        if (didLongPress) setTimeout(() => { suppressClick.current = false; }, 0);
      }}
      onPointerCancel={clearPress}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="database-renameable__content">{children}</span>
      <button
        type="button"
        className="database-edit-button"
        aria-label="Rename"
        title="Rename"
        onClick={(event) => {
          event.stopPropagation();
          onRename?.();
        }}
      >
        <Icon name="pencil" size={14} />
      </button>
    </div>
  );
}

function RenameModal({ target, fields, defaults, onChangeFields, onResetField, onClose, onSave }) {
  const overlayRef = useRef(null);
  const overlayMouseDownRef = useRef(false);
  const dragRef = useRef(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [hasDragged, setHasDragged] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose?.(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const onDragPointerDown = (event) => {
    if (!window.matchMedia("(max-width: 760px)").matches || event.target.closest("input, button") || (event.pointerType === "mouse" && !event.target.closest(".rename-modal__handle"))) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  };
  const onDragPointerMove = (event) => {
    const drag = dragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.y;
    if (!drag.dragging && (deltaY < 8 || deltaY < Math.abs(event.clientX - drag.x))) return;
    if (!drag.dragging) { drag.dragging = true; event.currentTarget.setPointerCapture(event.pointerId); }
    setIsDragging(true);
    setHasDragged(true);
    drag.offset = Math.max(0, deltaY);
    setDragOffset(drag.offset);
  };
  const onDragPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag?.dragging) return;
    if (drag.offset > 90) onClose?.();
    else { setDragOffset(0); setIsDragging(false); }
  };
  const onDragPointerCancel = () => { dragRef.current = null; setDragOffset(0); setIsDragging(false); };
  const handleOverlayMouseDown = (e) => { overlayMouseDownRef.current = (e.target === overlayRef.current); };
  const handleOverlayMouseUp   = (e) => {
    if (e.target === overlayRef.current && overlayMouseDownRef.current) onClose?.();
    overlayMouseDownRef.current = false;
  };
  if (!target) return null;

  const commonInputStyle = {
    flex: 1,
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid #555",
    background: "#222",
    color: "white",
  };
  const rowStyle = { display: "flex", alignItems: "center", gap: 8, marginTop: 10 };

  const renderTrackForm = () => (
    <>
      <div style={rowStyle}>
        <label style={{ width: 80 }}>name:</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <input
            type="text"
            value={fields.name ?? ""}
            onChange={(e) => onChangeFields((prev) => ({ ...prev, name: e.target.value }))}
            style={commonInputStyle}
          />
          {fields.name !== defaults.nameDefault && (
            <button
              onClick={() => onResetField("name")}
              style={{ border: "1px solid #555", background: "transparent", color: "white", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
            >
              reset to default
            </button>
          )}
        </div>
      </div>
    </>
  );

  const renderSectionForm = () => (
    <>
      <div style={rowStyle}>
        <label style={{ width: 80 }}>name:</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <input
            type="text"
            value={fields.name ?? ""}
            onChange={(e) => onChangeFields((prev) => ({ ...prev, name: e.target.value }))}
            style={commonInputStyle}
          />
          {fields.name !== defaults.nameDefault && (
            <button
              onClick={() => onResetField("name")}
              style={{ border: "1px solid #555", background: "transparent", color: "white", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
            >
              reset to default
            </button>
          )}
        </div>
      </div>

      <div style={rowStyle}>
        <label style={{ width: 80 }}>button:</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <input
            type="text"
            value={fields.button ?? ""}
            onChange={(e) => onChangeFields((prev) => ({ ...prev, button: e.target.value }))}
            style={commonInputStyle}
            placeholder="Same as its name"
          />
          {/* Show reset only if different from default (including empty default) */}
          {fields.button !== (defaults.buttonDefault ?? "") && (
            <button
              onClick={() => onResetField("button")}
              style={{ border: "1px solid #555", background: "transparent", color: "white", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
            >
              reset to default
            </button>
          )}
        </div>
      </div>
    </>
  );

  const renderModeForm = () => (
    <>
      <div style={rowStyle}>
        <label style={{ width: 80 }}>name:</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
          <input
            type="text"
            value={fields.name ?? ""}
            onChange={(e) => onChangeFields((prev) => ({ ...prev, name: e.target.value }))}
            style={commonInputStyle}
          />
          {fields.name !== defaults.nameDefault && (
            <button
              onClick={() => onResetField("name")}
              style={{ border: "1px solid #555", background: "transparent", color: "white", borderRadius: 6, padding: "4px 8px", cursor: "pointer" }}
            >
              reset to default
            </button>
          )}
        </div>
      </div>
    </>
  );

  const title =
    target.type === "track"  ? `Rename Track: ${target.trackName}` :
    target.type === "section"? `Rename Section: ${target.sectionKey}` :
    target.type === "mode"   ? `Rename Mode: ${target.isBase ? "base" : target.modeName}` :
    "Rename";

  return (
    <div
      ref={overlayRef}
      onMouseDown={handleOverlayMouseDown}
      onMouseUp={handleOverlayMouseUp}
      className="rename-overlay"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 10000
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`rename-modal ${isDragging ? "is-dragging" : ""} ${hasDragged ? "has-dragged" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
        onPointerCancel={onDragPointerCancel}
        style={{ transform: dragOffset ? `translateY(${dragOffset}px)` : undefined }}
      >
        <div className="rename-modal__handle" aria-hidden="true"><span /></div>
        <div className="rename-modal__header">
          <h3 style={{ margin: 0, fontSize: 16 }}>{title}</h3>
        </div>

        {/* FORM */}
        <div className="rename-modal__form" style={{ marginTop: 12 }}>
          {target.type === "track"   && renderTrackForm()}
          {target.type === "section" && renderSectionForm()}
          {target.type === "mode"    && renderModeForm()}
        </div>

        {/* ACTIONS */}
        <div className="rename-modal__actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={onClose}
            className="database-button database-button--quiet"
            style={{ border: "1px solid #555", background: "transparent", color: "white", borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
          >
            cancel
          </button>
          <button
            onClick={onSave}
            className="database-button database-button--primary"
            style={{ border: "none", background: "#0aa", color: "#002", fontWeight: 700, borderRadius: 8, padding: "6px 12px", cursor: "pointer" }}
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}
