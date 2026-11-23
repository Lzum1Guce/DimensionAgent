/** Chat and Work keep independent group memberships, just like their Bot lists. */
export function reconcileGroupRosters(prefs, groups, mode = 'chat') {
  const ids = [...new Set(groups.filter(group => group?.id).map(group => String(group.id)))];
  const live = new Set(ids), initialized = Array.isArray(prefs.knownGroupIds);
  const known = new Set(prefs.knownGroupIds || []);
  // Preserve access to existing groups on upgrade. Later additions belong only
  // to the mode that created/imported them; removing one never restores it here.
  const chat = new Set(initialized ? (prefs.chatGroups || []).filter(id => live.has(id)) : ids);
  const work = new Set(initialized ? (prefs.workGroups || []).filter(id => live.has(id)) : ids);
  if (initialized) for (const id of ids)
    if (!known.has(id) && !groups.some(group => group.id === id && group.rosterManaged === true))
      (mode === 'work' ? work : chat).add(id);
  // Native backends own both mode flags. Local preferences cannot silently
  // reattach a group after migration, removal, restart or another-window edit.
  for (const group of groups) if (group?.rosterManaged === true) {
    chat.delete(group.id); work.delete(group.id);
    if (group.inChat === true) chat.add(group.id);
    if (group.inWork === true) work.add(group.id);
  }
  return { ...prefs, chatGroups: [...chat], workGroups: [...work], knownGroupIds: ids };
}
