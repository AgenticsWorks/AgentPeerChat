import { conversationGraph, threadPeople } from './conversation-view.js';
const ns = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function action(node, label, run) {
  node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.setAttribute('aria-label', label);
  node.addEventListener('click', run);
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); run(); } });
}
export function renderConversationGraph(container, threads, options) {
  container.replaceChildren();
  const { people, conversations } = conversationGraph(threads), { t } = options;
  if (!conversations.length) { const p = document.createElement('p'); p.textContent = t('No conversation connections yet.'); container.append(p); return; }
  const height = Math.max(600, people.length * 58), middle = height / 2;
  const svg = svgNode('svg', { viewBox: `0 0 1000 ${height}`, 'aria-label': t('Conversation map'), class: 'conversation-svg' });
  const positions = new Map(people.map((person, i) => {
    const angle = -Math.PI / 2 + i * Math.PI * 2 / people.length;
    return [person.id, { x: 500 + Math.cos(angle) * 365, y: middle + Math.sin(angle) * (middle - 85) }];
  }));
  const edges = svgNode('g', { class: 'map-edges' }), nodes = svgNode('g'); svg.append(edges, nodes);
  const groups = conversations.filter(thread => thread.kind !== 'direct');
  for (const thread of conversations) {
    const members = threadPeople(thread).filter(p => positions.has(p.id));
    if (thread.kind === 'direct' && members.length === 2) {
      const a = positions.get(members[0].id), b = positions.get(members[1].id);
      const edge = svgNode('g', { class: 'map-direct' });
      const path = `M ${a.x} ${a.y} Q 500 ${middle - 35} ${b.x} ${b.y}`;
      edge.append(svgNode('path', { d: path, class: 'edge-hit' }), svgNode('path', { d: path, class: 'edge-line' }));
      const mx = (a.x + 2 * 500 + b.x) / 4, my = (a.y + 2 * (middle - 35) + b.y) / 4;
      edge.append(svgNode('rect', { x: mx - 15, y: my - 13, width: 30, height: 26, rx: 9 }), svgNode('text', { x: mx, y: my + 5, 'text-anchor': 'middle' }, '↔'));
      action(edge, `${members.map(p => p.name).join(' ↔ ')} · ${t('Direct chat')}`, () => options.openThread(thread.id)); edges.append(edge);
    } else {
      const i = groups.indexOf(thread), angle = i * Math.PI * 2 / Math.max(groups.length, 1);
      const hub = { x: groups.length === 1 ? 500 : 500 + Math.cos(angle) * 115, y: groups.length === 1 ? middle : middle + Math.sin(angle) * 115 };
      for (const member of members) { const pos = positions.get(member.id); edges.append(svgNode('path', { d: `M ${hub.x} ${hub.y} L ${pos.x} ${pos.y}`, class: 'group-edge' })); }
      const group = svgNode('g', { class: 'map-group', transform: `translate(${hub.x},${hub.y})` });
      group.append(svgNode('rect', { x: -76, y: -52, width: 152, height: 104, rx: 18 }));
      for (const [j, person] of members.slice(0, 3).entries()) drawAvatar(group, person, j === 0 ? 0 : j === 1 ? -16 : 16, j === 0 ? -30 : -7, 16, options.icon);
      group.append(svgNode('text', { y: 28, 'text-anchor': 'middle' }, thread.title.length > 18 ? thread.title.slice(0, 17) + '…' : thread.title), svgNode('text', { y: 44, 'text-anchor': 'middle', class: 'map-kind' }, `${t('Group chat')} · ${members.length}`));
      action(group, `${thread.title} · ${t('Group chat')}`, () => options.openThread(thread.id)); nodes.append(group);
    }
  }
  for (const person of people) {
    const pos = positions.get(person.id), node = svgNode('g', { transform: `translate(${pos.x},${pos.y})`, class: 'map-person' });
    drawAvatar(node, person, 0, 0, 29, options.icon);
    node.append(svgNode('text', { y: 49, 'text-anchor': 'middle' }, person.name.length > 24 ? person.name.slice(0, 23) + '…' : person.name));
    if (person.kind === 'agent') action(node, person.name, () => options.chooseAgent(person.id));
    else node.append(svgNode('title', {}, person.name));
    nodes.append(node);
  }
  container.append(svg);
}
function drawAvatar(parent, person, x, y, radius, icon) {
  parent.append(svgNode('circle', { cx: x, cy: y, r: radius, fill: '#fff', stroke: '#267364', 'stroke-width': 2 }));
  const source = icon(person);
  if (source) parent.append(svgNode('image', { href: source, x: x - radius + 4, y: y - radius + 4, width: radius * 2 - 8, height: radius * 2 - 8 }));
  else parent.append(svgNode('text', { x, y: y + 6, 'text-anchor': 'middle', fill: '#267364', 'font-size': radius < 20 ? 13 : 19 }, person.name.slice(0, 1).toUpperCase()));
}
