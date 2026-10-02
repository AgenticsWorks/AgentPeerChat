export function chatName(thread, viewerId) {
  if (thread.kind !== 'direct') return thread.title;
  const others = (thread.participants ?? thread.members ?? []).filter(person => person.id !== viewerId);
  return others.map(person => person.name).join('、') || thread.title;
}
export function chatsForPerspective(threads, perspective, viewerId) {
  if (perspective === 'all') return threads;
  const id = perspective === 'mine' ? viewerId : perspective;
  return threads.filter(thread => (thread.participants ?? []).some(person => person.id === id));
}
