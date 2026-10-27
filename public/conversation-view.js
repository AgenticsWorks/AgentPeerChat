export function threadPeople(thread) { return thread?.participants ?? thread?.members ?? []; }
export function isDisabled(person) { return person?.active === 0 || person?.active === false; }
export function avatarIcon(person) {
  if (person.avatar?.startsWith('data:image/')) return person.avatar;
  if (/^preset:(dots|grok|muse)$/.test(person.avatar ?? '')) return '/avatars/'+person.avatar.slice(7)+'.svg';
  const name = person.name.toLowerCase();
  if (/^muse(?:\b|\s)/.test(name)) return '/avatars/muse.svg';
  if (/^dots(?:\b|\s)/.test(name)) return '/avatars/dots.svg';
  if (/^(grok|grog)(?:\b|\s)/.test(name)) return '/avatars/grok.svg';
  return null;
}

// A conversation with no enabled peer belongs in history, not the daily chat list.
export function archivedConversation(thread, principals = []) {
 const directory=new Map(principals.map(person=>[person.id,person]));
 const peers=threadPeople(thread).filter(person=>!['owner','human'].includes(person.kind));
 return peers.length>0&&(thread.kind==='direct'?peers.some(person=>isDisabled(directory.get(person.id)||person)):peers.every(person=>isDisabled(directory.get(person.id)||person)));
}
