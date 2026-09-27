import Icon from "./Icon";

export default function AutoplayButton({ enabled, onToggle, disabled = false }) {
  return (
    <button
      type="button"
      className={`autoplay-switch ${enabled ? "is-on" : ""}`}
      role="switch"
      aria-label="Auto-Play"
      aria-checked={enabled}
      title={`Auto-Play ${enabled ? "on" : "off"}`}
      disabled={disabled}
      onClick={() => onToggle?.(!enabled)}
    >
      <span className="autoplay-switch__thumb">
        <Icon name={enabled ? "play" : "pause"} size={14} />
      </span>
    </button>
  );
}
