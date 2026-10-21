export function threadPeople(thread) { return thread?.participants ?? thread?.members ?? []; }
export function visibleThreads(threads, perspective = 'all') {
  return perspective === 'all' ? threads : threads.filter(thread => threadPeople(thread).some(person => person.id === perspective));
}
export function isDisabled(person) { return person?.active === 0 || person?.active === false; }
export function conversationGraph(threads, perspective = 'all', {principals = [], showDisabled = false} = {}) {
  // Thread summaries omit active state. Join only their existing members with
  // the current directory; never introduce people outside authorized threads.
  const directory = new Map(principals.map(person => [person.id, person]));
  const projected = threads.flatMap(thread => {
    const members = threadPeople(thread);
    const people = members.map(person => {
      const active = directory.get(person.id)?.active;
      return active === undefined ? person : {...person, active};
    }).filter(person => showDisabled || !isDisabled(person));
    // A hidden endpoint removes a direct edge, not the history behind it.
    // Groups retain their enabled members without dangling links or empty hubs.
    if (!people.length || (thread.kind === 'direct' && people.length !== members.length)) return [];
    return [{...thread, ...('participants' in thread ? {participants: people} : {members: people})}];
  });
  const conversations = visibleThreads(projected, perspective);
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
