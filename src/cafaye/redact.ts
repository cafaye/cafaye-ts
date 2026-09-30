// Removing credentials from anything this package is about to hand a human.
//
// WHY THIS FILE EXISTS AT ALL
//
// The failure it prevents is not hypothetical and it is not subtle. This package
// is the one place in a consumer's application that touches every credential it
// has. It holds a token, and a thrown exception's `message` is the single most
// likely thing in a Node process to end up in a log file, a crash reporter, a
// support ticket or a terminal that is being shoulder-surfed. `error.message`
// reaches all four by default, with no configuration: `console.error(e)` prints
// it, and a crash reporter that has not been told otherwise prints it too.
//
// So the rule is not "be careful when building messages". It is that no string
// this package constructs out of anything a service or a caller supplied passes
// through a redactor first, and the redactor's behaviour is a test
// (`test/wrapper-redaction.test.mjs`) rather than a review comment.
//
// THE RULE: ALL OR NOTHING
//
// A string either comes back unchanged or comes back as one marker. There is no
// partial redaction, and that is the load-bearing decision. The obvious
// implementation — replace the substrings you recognise, return the rest — is
// wrong in a way that gets worse the more carefully it is written, because it
// invites a reader to add one more pattern, and the day the reader adds a pattern
// with a gap in it is the day a credential ships. There is no such day here: a
// string that matched anything at all is not shown, so a pattern with a gap can
// only ever cause a false NEGATIVE for "this string is clean", and it cannot
// cause a false positive leak... which is precisely the residual risk, and it is
// why the two kinds of match below are deliberately generous rather than
// precise. A `Cookie:` header line is redacted whole, so a cookie value this
// package has never heard of is still removed.
//
// WHAT MATCHES
//
//   1. Exact values the instance was constructed with. The class knows the one
//      or two credentials it holds, so it can recognise them character for
//      character. This is what catches a service echoing a caller's own token
//      back inside a problem `detail`.
//
//   2. Structural shapes: the `cafaye_` API-token prefix, a JWS compact
//      serialization, and any `Authorization` / `Proxy-Authorization` / `Cookie` /
//      `Set-Cookie` header line. This is what catches credentials the instance
//      never held — a `Set-Cookie` on a response it did not authenticate, or a
//      header a caller built by hand.
//
// WHAT DOES NOT MATCH, DELIBERATELY
//
// Ordinary prose that happens to contain the words. "the request was not
// authorized" is a message worth having. `connect ECONNREFUSED 127.0.0.1:443` is
// the single most useful line in a network error and nothing here touches it. A
// 32-hex `trace_id` survives, which matters more than it sounds: core's
// conventions say support starts from the `trace_id`, so a redactor that ate it
// would have made every unsupported failure harder to report.

/**
 * The replacement for any string that matched. It is a constant so that a
 * consumer can recognise it, and it is deliberately not an empty string: a
 * message that is suddenly blank reads as "the error had no detail", which is a
 * different and wrong conclusion.
 */
export const REDACTED = '[redacted: a credential-shaped value was present]';

/**
 * Anything that could carry a credential, matched structurally.
 *
 * Kept as one alternation so the "did anything match" question is one question,
 * which is what makes the all-or-nothing rule cheap to implement honestly.
 * The `cookie` and `authorization` alternatives run to the end of the line
 * rather than to the first space, because a cookie value contains neither and a
 * `Set-Cookie` line carries four attributes after the one that matters.
 */
const CREDENTIAL_SHAPES =
  /\bcafaye_[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*|(?:^|[\s,;])(?:proxy-)?authorization\s*:\s*\S+|(?:^|[\s,;])(?:set-)?cookie\s*:\s*[^\r\n]*/gi;

/**
 * A redactor bound to a set of known secrets.
 *
 * `secrets` are exact credential values to remove wherever they appear, and are
 * the reason the redactor is constructed per instance rather than once per
 * module: the values it knows are the values this `Cafaye` instance holds.
 *
 * `maxLength` truncates a string that came back clean. `0` does not truncate.
 */
export function createRedactor(
  secrets: readonly string[] = [],
  maxLength = 0,
): (value: unknown) => string {
  // Longest first, so a secret that is a prefix of another cannot be replaced
  // part-way and leave a tail behind. With the all-or-nothing rule that
  // particular bug is harmless — either string still matches — but ordering by
  // length costs nothing and keeps the intent obvious to the next reader.
  const exact = [...new Set(secrets.filter((s) => typeof s === 'string' && s.length > 0))].sort(
    (a, b) => b.length - a.length,
  );

  return function redact(value: unknown): string {
    const text =
      typeof value === 'string'
        ? value
        : value === undefined || value === null
          ? ''
          : String(value);

    // FIRST, before anything else, including truncation. Truncating first and
    // then looking would mean only the first `maxLength` characters were ever
    // checked, which is a hole rather than an optimisation.
    for (const secret of exact) {
      if (text.includes(secret)) return REDACTED;
    }
    if (CREDENTIAL_SHAPES.test(text)) {
      // `lastIndex` matters: the alternation is global, so without resetting it
      // a second call on a different string would start mid-pattern and could
      // skip the match entirely. That is the kind of bug that passes a test
      // which only redacts once.
      CREDENTIAL_SHAPES.lastIndex = 0;
      return REDACTED;
    }
    CREDENTIAL_SHAPES.lastIndex = 0;

    if (maxLength > 0 && text.length > maxLength) {
      return `${text.slice(0, maxLength - 1).trimEnd()}…`;
    }
    return text;
  };
}

/**
 * Keep a platform error as a `cause`, unless there is something in it to keep out
 * of one.
 *
 * A `cause` is how the errno survives: undici's `TypeError: fetch failed` says
 * nothing, and the difference between a refused connection and a certificate that
 * expired is one level down. So the original object is normally preserved
 * untouched, and a caller who wants `err.cause.cause.code` has it.
 *
 * Except when the redactor finds a credential in it. A `cause` is a real object
 * this package does not own, and it is reachable — Node's `util.inspect` prints
 * it, `console.error(err)` prints it, every crash reporter prints it. Passing a
 * partially-scrubbed copy would be the worst of both: a cause that is no longer
 * the platform's, carrying a message that is no longer true. So when there is
 * anything to withhold, the original is withheld ENTIRELY and replaced with a
 * stand-in that says so, keeping the `name` and the `code` because those are
 * enums rather than prose and are the part a handler branches on.
 *
 * This is the same all-or-nothing rule as `redact` itself, applied one level out:
 * a scrubber that removes what it recognises and returns the rest invites a
 * reader to add one more pattern, and the day that pattern has a gap is the day a
 * credential ships.
 */
export function safeCause(error: unknown, redact: (value: unknown) => string): unknown {
  if (error === null || error === undefined) return error;
  if (typeof error !== 'object') {
    return redact(error) === String(error) ? error : new Error(REDACTED);
  }

  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && redact(message) === message) return error;

  const stand = new Error(
    `${REDACTED} — the original platform error carried a credential-shaped value, so it is ` +
      'not attached. Its name and code are kept because those are enums and are what a ' +
      'handler branches on.',
  );
  stand.name = typeof (error as { name?: unknown }).name === 'string' ? (error as Error).name : 'Error';
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    Object.defineProperty(stand, 'code', { value: code, enumerable: false, writable: true });
  }
  return stand;
}
