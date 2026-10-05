import { fail } from './security';
export function avatarValue(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') fail(400, 'invalid_avatar', 'Choose a preset or upload a PNG, JPEG or WebP image.');
  if (/^preset:(dots|grok|muse)$/.test(value)) return value;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || value.length > 61000) fail(400, 'invalid_avatar', 'Avatar must be a PNG, JPEG or WebP image below 45 KB.');
  let bytes: string; try { bytes = atob(match[2]); } catch { fail(400, 'invalid_avatar', 'Invalid image encoding.'); }
  const valid = match[1] === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? bytes.startsWith('\xff\xd8\xff') : bytes.startsWith('RIFF') && bytes.slice(8,12) === 'WEBP';
  if (!valid || bytes.length > 45000) fail(400, 'invalid_avatar', 'Invalid or oversized image.');
  return value;
}
