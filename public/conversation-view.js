export function threadPeople(thread) { return thread?.participants ?? thread?.members ?? []; }
export function visibleThreads(threads, perspective = 'all') {
  return perspective === 'all' ? threads : threads.filter(thread => threadPeople(thread).some(person => person.id === perspective));
}
export function conversationGraph(threads, perspective = 'all') {
  const conversations = visibleThreads(threads, perspective);
  const people = new Map();
  for (const thread of conversations) for (const person of threadPeople(thread)) people.set(person.id, person);
  return { people: [...people.values()], conversations };
}
export function avatarIcon(person) {
  if (person.avatar?.startsWith('data:image/')) return person.avatar;
  if (/^preset:(dots|grok|muse)$/.test(person.avatar ?? '')) return '/avatars/'+person.avatar.slice(7)+'.svg';
  const name = person.name.toLowerCase();
  if (/^muse(?:\b|\s)/.test(name)) return '/avatars/muse.svg';
  if (/^dots(?:\b|\s)/.test(name)) return '/avatars/dots.svg';
  if (/^(grok|grog)(?:\b|\s)/.test(name)) return '/avatars/grok.svg';
  return null;
}
