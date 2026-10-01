import Icon from "./Icon";

export default function AutoplayButton({ enabled, onToggle, disabled = false, flashing = false, suspended = false }) {
  return (
    <button
      type="button"
      className={`autoplay-switch ${enabled ? "is-on" : ""} ${flashing ? "is-flashing" : ""} ${suspended ? "is-suspended" : ""}`}
      role="switch"
      aria-label="Auto-Play"
      aria-checked={enabled}
      title={suspended ? "Auto-Play temporarily off until this track stops" : `Auto-Play ${enabled ? "on" : "off"}`}
      disabled={disabled}
      onClick={() => onToggle?.(!enabled)}
    >
      <span className="autoplay-switch__thumb">
        <Icon name={enabled ? "play" : "pause"} size={14} />
      </span>
    </button>
  );
}
