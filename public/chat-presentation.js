import {t} from './i18n.js';
export function chatName(thread, viewerId) {
  if (thread.kind !== 'direct') return thread.title;
  const others = (thread.participants ?? thread.members ?? []).filter(person => person.id !== viewerId);
  return others.map(person => person.name).join(', ') || thread.title;
}
// Delivery targets come from thread membership, never from @mentions in text.
export function messageDirection(thread, senderId, senderName) {
  const members = thread?.participants ?? thread?.members ?? [];
  const destination = thread?.kind === 'direct'
    ? members.filter(person => person.id !== senderId).map(person => person.name).join(', ') || t("联系人")
    : t("群聊 · {0}", thread?.title ?? t("聊天"));
  return `${senderName} → ${destination}`;
}
