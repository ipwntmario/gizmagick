import Icon from "./Icon";

export default function TrackVolumeControl({ open, onOpenChange, volume, onVolumeChange, disabled = false }) {
  const percent = Math.round(volume * 100);

  return (
    <div className="track-volume-control">
      <button
        type="button"
        aria-label="Track volume"
        aria-expanded={open && !disabled}
        onClick={() => onOpenChange?.(!open)}
        disabled={disabled}
        className="now-playing__volume"
        title="Track volume (set for all players)"
      >
        <Icon name={volume === 1 ? "volume" : "volumeLow"} size={19} />
      </button>

      {open && !disabled && (
        <div className="track-volume-control__popover">
          <div className="track-volume-control__label">Track volume (set for all players)</div>
          <div className="track-volume-control__slider">
            <span>{percent}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={percent}
              onChange={(event) => onVolumeChange?.(Number(event.target.value) / 100)}
              aria-label="Track volume"
            />
          </div>
        </div>
      )}
    </div>
  );
}
