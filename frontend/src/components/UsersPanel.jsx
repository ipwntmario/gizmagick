import React from "react";
import Icon from "./Icon";

const roleIcon = (role) => {
  switch (role) {
    case "GM": return "mixer";
    case "PASSIVE_BTS": return "eye";
    default: return "headphones";
  }
};

export default function UsersPanel({ users = [], latencyMs, offsetMs, showClockOffset = false }) {
  return (
    <div
      style={{
        background: "rgba(15, 23, 42, 0.6)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 10,
        padding: 10,
        color: "white",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Users</div>

      <div style={{ display: "grid", gap: 6 }}>
        {users.length === 0 && (
          <div style={{ opacity: 0.7, fontSize: 13 }}>No one connected</div>
        )}
        {users.map((u) => (
          <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 18, display: "inline-flex", justifyContent: "center" }}><Icon name={roleIcon(u.role)} size={17} /></span>
            <span style={{ fontWeight: 500 }}>{u.name || "Unknown"}</span>
            {(u.ready || u.loading) && <span style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 6,
              background: u.ready ? "rgba(16,185,129,0.25)" : "rgba(245,158,11,0.25)",
              border: `1px solid ${u.ready ? "rgba(16,185,129,0.5)" : "rgba(245,158,11,0.5)"}`,
            }}>
              {u.ready ? "ready" : "loading"}
            </span>}
          </div>
        ))}
      </div>

      {(latencyMs != null || (showClockOffset && offsetMs != null)) && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
          {latencyMs != null && <div>Latency: {Math.round(latencyMs)} ms</div>}
          {showClockOffset && offsetMs != null && <div>Clock offset: {Math.round(offsetMs)} ms</div>}
        </div>
      )}
    </div>
  );
}
