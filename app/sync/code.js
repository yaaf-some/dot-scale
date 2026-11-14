// Household code format, shared by the browser client and the Worker (plain ES module, no DOM, no Node APIs),
// so the two can never disagree about what a valid code looks like.

/** Lower-case, trim, and turn spaces/underscores into dashes: " Maple Tiger_orbit 4271 " -> "maple-tiger-orbit-4271". */
export function normalizeCode(input) {
  return String(input ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// Generated codes are `word-word-word-NNNN`; the server accepts a slightly wider shape so the format can grow.
const CODE_RE = /^[a-z0-9]+(?:-[a-z0-9]+){2,5}$/;
export const isValidCodeFormat = (c) => typeof c === 'string' && c.length <= 64 && CODE_RE.test(c);
