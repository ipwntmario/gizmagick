export function getPresenceChanges(previousUsers, nextUsers) {
  const changes = [];
  for (const [id, name] of nextUsers) {
    if (!previousUsers.has(id)) changes.push({ kind: "join", name });
  }
  for (const [id, name] of previousUsers) {
    if (!nextUsers.has(id)) changes.push({ kind: "leave", name });
  }
  return changes;
}
