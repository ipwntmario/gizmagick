import { useEffect, useRef } from "react";
import Icon from "./Icon";
import PrimaryPlaybackButton from "./PrimaryPlaybackButton";

const STOP_HOLD_MS = 500;

export default function Transport({
  disabled = false,
  primaryDisabled = false,
  stopDisabled = false,
  stopFadePhase = null,
  isLoadingTrack,
  isPlaying,
  isPaused,
  onPlay,      // () => void
  onPause,     // () => void
  onResume,    // () => void
  onStop,      // ({ quick?: boolean }) => void
  onUndo,
  undoDisabled = true,
  undoLabel = "Undo last queued change",
  isStopHighlighted, // simple tracks or dynamic tracks with no ending section
  unlockAudio,
  leftControl,
  rightControl,
}) {
  const stopHoldTimer = useRef(null);
  const suppressStopClick = useRef(false);

  const cancelStopHold = () => {
    if (stopHoldTimer.current != null) clearTimeout(stopHoldTimer.current);
    stopHoldTimer.current = null;
  };

  useEffect(() => () => {
    if (stopHoldTimer.current != null) clearTimeout(stopHoldTimer.current);
  }, []);

  const startStopHold = (event) => {
    if (event.button !== 0 || disabled || stopDisabled || !isPlaying) return;
    cancelStopHold();
    suppressStopClick.current = false;
    stopHoldTimer.current = setTimeout(() => {
      stopHoldTimer.current = null;
      suppressStopClick.current = true;
      onStop?.({ quick: true });
    }, STOP_HOLD_MS);
  };

  const finishStopHold = () => {
    cancelStopHold();
  };

  return (
    <section className="transport-row">
      {leftControl && <div className="transport-side-control transport-side-control--left">{leftControl}</div>}
      <div className="transport-controls">
        {/* Undo the most recent reversible playback or queue action */}
        <button
          onClick={() => onUndo?.()}
          title={undoDisabled ? "Nothing to undo" : undoLabel}
          aria-label={undoLabel}
          disabled={disabled || undoDisabled}
          className="transport-undo"
        >
          <Icon name="undo" size={20} />
        </button>

        {/* Play/Pause/Resume */}
        <PrimaryPlaybackButton
          disabled={disabled || primaryDisabled}
          isLoadingTrack={isLoadingTrack}
          isPlaying={isPlaying}
          isPaused={isPaused}
          onPlay={onPlay}
          onPause={onPause}
          onResume={onResume}
          unlockAudio={unlockAudio}
        />

        {/* Stop */}
        <button
          onClick={() => {
            if (suppressStopClick.current) {
              suppressStopClick.current = false;
              return;
            }
            if (!disabled && !stopDisabled && isPlaying) onStop?.();
          }}
          onPointerDown={startStopHold}
          onPointerUp={finishStopHold}
          onPointerCancel={finishStopHold}
          onPointerLeave={cancelStopHold}
          onKeyDown={() => { suppressStopClick.current = false; }}
          onContextMenu={(event) => event.preventDefault()}
          title={stopFadePhase === "quick" ? "Turn off Auto-Play" : stopFadePhase === "normal" ? "Quick stop" : "Stop (hold for a quick fade)"}
          aria-label={stopFadePhase === "quick" ? "Turn off Auto-Play" : stopFadePhase === "normal" ? "Quick stop" : "Stop; press and hold for a quick fade"}
          disabled={disabled || stopDisabled || !isPlaying}
          className={`transport-stop ${isPlaying && isStopHighlighted && !stopDisabled ? "is-highlighted" : ""}`}
        >
          <Icon name="stop" size={18} />
        </button>
      </div>
      {rightControl && <div className="transport-side-control">{rightControl}</div>}
    </section>
  );
}
