/**
 * Classic emoticons that chat shows as emoji. Display only: the stored text,
 * what the agent receives, copy and the composer keep the original characters.
 */
const EMOJI_BY_EMOTICON: ReadonlyMap<string, string> = new Map([
  [":)", "🙂"],
  [":-)", "🙂"],
  [":D", "😄"],
  [":-D", "😄"],
  [";)", "😉"],
  [";-)", "😉"],
  [":(", "🙁"],
  [":-(", "🙁"],
  [":P", "😛"],
  [":p", "😛"],
  [":O", "😮"],
  [":o", "😮"],
  ["xD", "😆"],
  ["XD", "😆"],
  ["<3", "❤️"],
]);

const EMOTICON_ANYWHERE = /[:;]-?[)(DPpOo]|[xX]D|<3/;
const TOKEN_STARTS = new Set([...EMOJI_BY_EMOTICON.keys()].map((emoticon) => emoticon[0]!));

// Markdown emphasis markers count as punctuation, so `*:D*` reads the same as
// source and as rendered text.
const OPENING_PUNCTUATION = new Set(["(", "[", "{", '"', "'", "“", "‘", "«", "*", "_", "~"]);
const CLOSING_PUNCTUATION = new Set([
  ".",
  ",",
  "!",
  "?",
  ";",
  ":",
  ")",
  "]",
  "}",
  '"',
  "'",
  "”",
  "’",
  "»",
  "…",
  "*",
  "_",
  "~",
]);

const isWhitespace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/** A cheap check before parsing markdown for emoticons; true for any candidate. */
export function mayContainEmoticon(text: string): boolean {
  return EMOTICON_ANYWHERE.test(text);
}

/** Where a backtick code span starting at `start` ends; unmatched backticks are literal. */
function codeSpanEnd(text: string, start: number): number {
  let runEnd = start;
  while (text[runEnd] === "`") runEnd += 1;
  const fence = text.slice(start, runEnd);
  let search = runEnd;
  while (true) {
    const close = text.indexOf(fence, search);
    if (close === -1) return runEnd;
    let closeEnd = close + fence.length;
    if (text[closeEnd] !== "`") return closeEnd;
    while (text[closeEnd] === "`") closeEnd += 1;
    search = closeEnd;
  }
}

// A token is its own word: only opening punctuation before it and closing
// punctuation after it.
function startsWord(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && OPENING_PUNCTUATION.has(text[start - 1]!)) start -= 1;
  return start === 0 || isWhitespace(text[start - 1]);
}

function endsWord(text: string, index: number): boolean {
  let end = index;
  while (end < text.length && CLOSING_PUNCTUATION.has(text[end]!)) end += 1;
  return end === text.length || isWhitespace(text[end]);
}

interface EmoticonMatch {
  readonly start: number;
  readonly end: number;
  readonly emoji: string;
}

function emoticonAt(text: string, index: number): string | undefined {
  for (const length of [3, 2]) {
    const candidate = text.slice(index, index + length);
    if (EMOJI_BY_EMOTICON.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The standalone emoticons in a run of prose. A token counts only as its own
 * word, so `C:\D…`, `std::D`, URLs and paths stay as they are, and backtick
 * code spans are skipped.
 */
export function findEmoticons(text: string): ReadonlyArray<EmoticonMatch> {
  if (!mayContainEmoticon(text)) return [];
  const matches: EmoticonMatch[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "`") {
      index = codeSpanEnd(text, index);
      continue;
    }
    const token = TOKEN_STARTS.has(char) ? emoticonAt(text, index) : undefined;
    if (token !== undefined && startsWord(text, index) && endsWord(text, index + token.length)) {
      matches.push({
        start: index,
        end: index + token.length,
        emoji: EMOJI_BY_EMOTICON.get(token)!,
      });
      index += token.length;
    } else {
      index += 1;
    }
  }
  return matches;
}

export function replaceEmoticons(text: string): string {
  let result = "";
  let last = 0;
  for (const match of findEmoticons(text)) {
    result += text.slice(last, match.start) + match.emoji;
    last = match.end;
  }
  return last === 0 ? text : result + text.slice(last);
}
