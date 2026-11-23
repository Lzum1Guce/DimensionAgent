/** Keep old chat streams and other groups from updating the visible conversation. */
export function createGroupStreams() {
  const groups = new Map();
  const current = (ticket) => groups.get(ticket.groupId)?.get(ticket.mode) === ticket;
  const begin = (groupId, mode) => {
    if (!groups.has(groupId)) groups.set(groupId, new Map());
    const ticket = { groupId, mode };
    groups.get(groupId).set(mode, ticket);
    return ticket;
  };
  const setMode = (ticket, mode) => {
    if (!current(ticket) || ticket.mode === mode) return;
    const room = groups.get(ticket.groupId);
    room.delete(ticket.mode); ticket.mode = mode; room.set(mode, ticket);
  };
  const finish = (ticket) => {
    if (!current(ticket)) return false;
    const room = groups.get(ticket.groupId);
    room.delete(ticket.mode);
    if (!room.size) groups.delete(ticket.groupId);
    return true;
  };
  return { begin, current, setMode, finish, busy: (groupId, mode) => mode ? groups.get(groupId)?.has(mode) || false : Boolean(groups.get(groupId)?.size) };
}
