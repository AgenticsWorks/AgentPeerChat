import { translations as baseTranslations } from './locales.js';
import { profileTranslations } from './profile-locales.js';
const translations = {...baseTranslations,...profileTranslations};

const english = new Map(Object.entries(translations));
const chinese = new Map(Object.entries(translations).map(([zh, en]) => [en, zh]));
let language = 'en';
try { if (typeof window !== 'undefined' && globalThis.localStorage?.getItem('agentgram.language') === 'zh') language = 'zh'; } catch {}
export const getLanguage = () => language;
export const getLocale = () => language === 'zh' ? 'zh-CN' : 'en-US';
export function t(source, ...values) {
  const text = language === 'en' ? english.get(source) ?? source : chinese.get(source) ?? source;
  return text.replace(/\{(\d+)\}/g, (_, index) => String(values[index] ?? `{${index}}`));
}
// Only the maintainer-authored fictional demo uses recursive translation.
export function localizeDemo(value) {
  if (typeof value === 'string') return t(value);
  if (Array.isArray(value)) return value.map(localizeDemo);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localizeDemo(item)]));
  return value;
}
const records = new WeakMap();
const excluded = 'script,style,textarea,input,pre,code,[data-user-content],.avatar,.thread-list,.message-list,.principal-grid,.contact-option,.member-row strong,.member-row small,.activity-card strong,#chat-title,#chat-members,#my-name,#composer-name,#field-principal,#token-list td:nth-child(-n+2),label:has(input[name="members"])';
function translated(source) {
  return language === 'en' ? english.get(source) ?? source : chinese.get(source) ?? source;
}
export function applyLanguage(root = document) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    if (!node.parentElement || node.parentElement.closest(excluded)) continue;
    const current = node.nodeValue, key = current.trim();
    if (!english.has(key) && !chinese.has(key)) continue;
    let record = records.get(node);
    if (!record || current !== record.last) record = { base: english.get(key) ?? key, prefix: current.match(/^\s*/)[0], suffix: current.match(/\s*$/)[0] };
    node.nodeValue = record.prefix + translated(record.base) + record.suffix;
    record.last = node.nodeValue; records.set(node, record);
  }
  // Labels and hints are UI; input values, names, messages and credentials are not.
  for (const node of root.querySelectorAll?.('[placeholder],[aria-label],[title],meta[content]') ?? []) {
    if (node.closest('[data-user-content]')) continue;
    for (const attribute of ['placeholder', 'aria-label', 'title', ...(node.tagName === 'META' ? ['content'] : [])]) {
      const value = node.getAttribute(attribute);
      if (value && (english.has(value) || chinese.has(value))) node.setAttribute(attribute, translated(english.get(value) ?? value));
    }
  }
  document.documentElement.lang = getLocale();
  for (const select of document.querySelectorAll('[data-language-switch]')) select.value = language;
}
export function setLanguage(value) {
  if (!['en', 'zh'].includes(value)) return;
  language = value;
  try { if (typeof window !== 'undefined') globalThis.localStorage?.setItem('agentgram.language', language); } catch {}
  if (typeof document !== 'undefined') {
    applyLanguage();
    document.dispatchEvent(new CustomEvent('agentpeerchat:languagechange', { detail: { language } }));
  }
}
export function initLanguage() {
  applyLanguage();
  for (const select of document.querySelectorAll('[data-language-switch]')) select.addEventListener('change', event => setLanguage(event.target.value));
  globalThis.AgentPeerChatI18n = { t, getLanguage, getLocale };
}
