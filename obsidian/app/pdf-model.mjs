/** Pure PDF reader state helpers; all ranges use original UTF-16 text offsets. */
export function parsePdfPage(value, total = Infinity) {
  const raw = typeof value === 'number' ? value : /(?:^|[#?&])page=([^&]+)/i.exec(String(value ?? ''))?.[1] ?? value;
  const number = Number(raw);
  const maximum = Number.isFinite(total) ? Math.max(1, Math.floor(total)) : Infinity;
  return Math.min(maximum, Math.max(1, Number.isFinite(number) ? Math.floor(number) : 1));
}

export function buildPdfText(items = []) {
  let text = '';
  const segments = [];
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const start = text.length;
    text += item.str;
    segments.push({ index: segments.length, start, end: text.length, text: item.str });
    if (item.hasEOL) text += '\n';
  }
  return { text, segments };
}

function normalizedSearch(value) {
  let text = '';
  const offsets = [];
  let original = 0;
  for (const character of String(value)) {
    const end = original + character.length;
    if (/\s/u.test(character)) {
      if (text.endsWith(' ')) offsets[offsets.length - 1].end = end;
      else { text += ' '; offsets.push({ start: original, end }); }
    } else {
      const normalized = character.normalize('NFKC').toLocaleLowerCase();
      text += normalized;
      for (let index = 0; index < normalized.length; index++) offsets.push({ start: original, end });
    }
    original = end;
  }
  return { text, offsets };
}

export function findPdfMatches(text, query) {
  const source = normalizedSearch(text);
  const needle = normalizedSearch(query).text.trim();
  if (!needle) return [];
  const matches = [];
  for (let from = 0; from <= source.text.length - needle.length;) {
    const index = source.text.indexOf(needle, from);
    if (index < 0) break;
    matches.push({ start: source.offsets[index].start, end: source.offsets[index + needle.length - 1].end });
    from = index + needle.length;
  }
  return matches;
}

export function matchSegments(segments, match) {
  return segments.filter(segment => segment.start < match.end && segment.end > match.start)
    .map(segment => ({ index: segment.index, start: Math.max(0, match.start - segment.start), end: Math.min(segment.text.length, match.end - segment.start) }));
}

export function pdfReference({ path, page = 1, text = '' }) {
  const link = `[[${path}#page=${parsePdfPage(page)}]]`;
  const selected = String(text).trim();
  return selected ? `${selected.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n${link}` : link;
}
