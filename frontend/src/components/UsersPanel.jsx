import Icon from "./Icon";

const roleIcon = (role) => {
  switch (role) {
    case "GM": return "mixer";
    case "PASSIVE_BTS": return "eye";
    default: return "headphones";
  }
};

export default function UsersPanel({ users = [], latencyMs, offsetMs, showClockOffset = false, showLatency = false, headerCount = null, playbackActive = false }) {
  return (
    <div className="users-panel">
      <div className="users-panel__heading">
        <strong>Users</strong>
        {headerCount != null && (
          <span className="session-panel__count" aria-label={`${headerCount} ${headerCount === 1 ? "person" : "people"} in session`}>
            <Icon name="user" size={13} />{headerCount}
          </span>
        )}
      </div>

      <div className="users-panel__list">
        {users.length === 0 && (
          <div className="users-panel__empty">No one connected</div>
        )}
        {users.map((u) => (
          <div key={u.id} className="users-panel__row">
            <span className="users-panel__role-icon"><Icon name={roleIcon(u.role)} size={17} /></span>
            <span className="users-panel__name">{u.name || "Unknown"}</span>
            {!playbackActive && (u.ready || u.loading) && <span className={`users-panel__status ${u.ready ? "is-ready" : "is-loading"}`}>
              {u.ready ? "ready" : "loading"}
            </span>}
          </div>
        ))}
      </div>

      {((showLatency && latencyMs != null) || (showClockOffset && offsetMs != null)) && (
        <div className="users-panel__timing">
          {showLatency && latencyMs != null && <div>Latency: {Math.round(latencyMs)} ms</div>}
          {showClockOffset && offsetMs != null && <div>Clock offset: {Math.round(offsetMs)} ms</div>}
        </div>
      )}
    </div>
  );
}
