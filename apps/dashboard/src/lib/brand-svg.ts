import markSource from '../../../../brand/stryx-mark.svg?raw';
import wordmarkSource from '../../../../brand/stryx-wordmark.svg?raw';

/** The brand SVGs, inlined (not <img>) so currentColor and --stryx-accent follow the theme. */
const clean = (svg: string): string =>
  svg
    .replace(/<metadata>[\s\S]*?<\/metadata>/, '')
    .replace(' xmlns:c2pa="http://c2pa.org/manifest"', '')
    .replace(/ role="img"/, '')
    .replace(/ aria-label="[^"]*"/, '')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');

export const MARK_HTML = clean(markSource).replace('<svg ', '<svg class="sidebar__mark" ');
export const WORDMARK_HTML = clean(wordmarkSource).replace('<svg ', '<svg class="sidebar__wordmark" ');

const ATOM_GROUP = '<g transform="translate(0 3) scale(2.6)">';
const ATOM_VIEWPORT = '<svg x="0" y="3" width="166.4" height="166.4" viewBox="0 0 64 64" overflow="visible">';
const ATOM_END = '</g></g><g transform="translate(180 120.5) scale(0.1025)">';

/** Puts the lockup's atom in its own 64x64 <svg> viewport, drawn identically (64 x 2.6 = 166.4). */
export function wrapAtomViewport(lockup: string): string {
  if (lockup.split(ATOM_GROUP).length !== 2 || lockup.split(ATOM_END).length !== 2) throw new Error('stryx-lockup.svg changed shape: update wrapAtomViewport');
  return lockup.replace(ATOM_GROUP, ATOM_VIEWPORT).replace(ATOM_END, '</g></svg><g transform="translate(180 120.5) scale(0.1025)">');
}
