// RFC 9457 problem documents, and the four ways a request can fail.
//
// Every non-2xx response from every cafaye service is `application/problem+json`
// — core's `docs/openapi-conventions.md` says "Every non-2xx response is
// `application/problem+json` (RFC 9457) with the cafaye extensions below. No
// service invents its own error body", and the six vendored documents agree,
// which is why the same `Problem` type appears in all six. That uniformity is
// the opportunity: one shape means one place to turn a failure into a value a
// caller can `catch` by type.
//
// THE HIERARCHY, AND WHY THERE IS A FALLBACK
//
//   CafayeError                      kind: 'problem' | 'protocol' | 'network' | 'configuration'
//   ├── CafayeProblemError           a problem document arrived
//   │   ├── CafayeUnauthenticatedError    401 unauthorized
//   │   ├── CafayeForbiddenError          403 forbidden
//   │   ├── CafayeNotFoundError           404 not_found
//   │   ├── CafayeRateLimitedError        429 rate_limited
//   │   ├── CafayeConflictError           409 conflict
//   │   │   └── CafayeIdempotencyKeyReusedError   409 idempotency_key_reused
//   │   └── CafayeValidationError         422 validation_failed
//   ├── CafayeProtocolError          an HTTP response that is not what the contract says
//   ├── CafayeNetworkError           no HTTP response at all
//   │   └── CafayeTimeoutError        the network failure was a timeout
//   └── CafayeConfigurationError     the options were wrong; no request was made
//
// `CafayeProblemError` is instantiable and is the fallback. A service that adds
// a code tomorrow produces a `CafayeProblemError` carrying that code, not a bare
// `Error` — the brief's phrasing is the requirement: "a client that throws a bare
// `Error` on an unrecognised problem type has moved the problem, not solved it."
// A caller can therefore always write `catch (e) { if (!isCafayeError(e)) throw e;
// … e.kind … e.status … e.code … }` and have it work against every failure this
// class can produce, including the ones nobody has seen yet.
//
// WHY `status` IS `number | null` RATHER THAN TWO ERROR TYPES
//
// The brief offers the choice — "One error type that covers both, with the
// distinction queryable — or two types and a stated rule for which one you throw"
// — and this takes the first, because the two types are not actually disjoint in
// the way a `switch` wants. A network failure and an HTTP failure are different
// in kind but identical in handling: both mean "this call did not produce a
// result", both want the same log line, and both are retried by the same code for
// most statuses. Making them one type with a queryable `kind` and a `status` that
// is `null` when there was no response means the common handler is
// `e.status !== null` rather than an `instanceof` ladder, and a caller who does
// care can still branch on `instanceof CafayeNetworkError`.
//
// The distinction is therefore BOTH queryable and subclassable, which is
// strictly more than either option alone, and the base class is the one a
// consumer catches.
//
// A TIMEOUT IS NOT A DNS FAILURE, and they do not collapse here.
//
// The brief asks for this explicitly. `CafayeTimeoutError` extends
// `CafayeNetworkError`, so `catch (e) { if (e instanceof CafayeNetworkError)
// retry() }` catches both, and `reason` distinguishes them without the caller
// having to know that Node reports a timeout as a `DOMException` named
// `TimeoutError` while a DNS failure is a `TypeError: fetch failed` with
// `cause.code === 'ENOTFOUND'`. `classifyNetworkFailure` is where that knowledge
// lives, and it is a pure function precisely so it can be tested without a
// socket, a timer, or a wait.
//
// THE THIRD WAY A REQUEST FAILS
//
// `CafayeProtocolError` exists because the contract has two edges the problem
// hierarchy does not cover, and both are judgement calls the brief asked to be
// made and stated:
//
//   - A non-2xx response whose body is NOT a problem document. Something between
//     the client and the service answered: a reverse proxy's HTML 502, a WAF's
//     challenge, a rate limiter that is not cafaye. There is a status and there
//     is no problem, so `CafayeProblemError` would be a lie about `type` and
//     `title`. The snippet of the body is kept — it is the single most useful
//     thing when diagnosing a proxy — but redacted, and dropped entirely if
//     anything credential-shaped is in it.
//
//   - A 2xx response whose body IS a problem document. The brief: "a
//     problem-shaped body with a 200 is not a success. Decide, test, and
//     document what you do with each." The answer is that this throws, because
//     the alternative is handing a caller a `Problem` where its types promised a
//     `User`. A typed client that quietly returns the wrong shape is worse than
//     one that stops: the first produces a `TypeError` three frames from the
//     mistake, and the second produces a diagnosis at the mistake.
//
// WHY `code` CHOOSES THE CLASS AND `status` IS THE FALLBACK
//
// core's conventions: "`type` is a stable `https://errors.cafaye.com/<code>` URI
// — the machine-readable contract" and "`code` is the same slug as the last
// segment of `type`". So `code` is the contract and `status` is a fact about one
// response that a service could get wrong, or omit, since RFC 9457 makes `status`
// advisory. Mapping on `code` first and falling back to `status` means a service
// that answers 403 with `code: "forbidden"` is a `CafayeForbiddenError` even if
// the number drifts, and a service that omits `code` entirely is still mapped
// from the number. A code this package has never heard of lands on
// `CafayeProblemError` with that code intact.

import { createRedactor, REDACTED } from './redact.js';

/** What kind of failure this is. Present on every error in this file. */
export type CafayeErrorKind = 'problem' | 'protocol' | 'network' | 'configuration';

/**
 * Why a request failed without producing a response.
 *
 * `timeout` and `aborted` are separate because they are the two cases a caller
 * most wants to treat differently and the two Node reports most similarly — both
 * arrive as an aborted request. `timeout` is this client giving up; `aborted` is
 * the caller's own `AbortSignal` firing, which is not a failure of anything and
 * must not be retried by a wrapper that does not know whose signal it was.
 */
export type NetworkFailureReason =
  | 'timeout'
  | 'aborted'
  | 'dns'
  | 'connection'
  | 'tls'
  | 'unknown';

/** The five RFC 9457 members, plus the two cafaye extensions core declares. */
const KNOWN_PROBLEM_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'trace_id',
  'errors',
]);

/** A brand that survives two copies of this package in one process. */
const ERROR_BRAND = Symbol.for('cafaye.ts.error');

/**
 * The base of everything this package throws.
 *
 * `kind` and `status` are the queryable half of the "one type or two" question;
 * `status` is `null` for everything that did not come with an HTTP response,
 * which is the check a caller writes to tell "the service said no" from "the
 * request never got there".
 *
 * The `cause` is kept. A `CafayeNetworkError` that discarded the underlying
 * `TypeError` would have swallowed `cause.code`, which is where Node puts the
 * difference between a refused connection and a certificate that expired.
 */
export class CafayeError extends Error {
  /** Which of the four failure modes this is. */
  readonly kind: CafayeErrorKind;
  /** The HTTP status, or `null` when no HTTP response was involved. */
  readonly status: number | null;

  constructor(
    message: string,
    options: { kind: CafayeErrorKind; status?: number | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CafayeError';
    this.kind = options.kind;
    this.status = options.status ?? null;
    // Non-enumerable on purpose: a marker that shows up in `Object.keys` or
    // `JSON.stringify` is a marker in somebody's log line, and the only thing it
    // needs to be is present.
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/** The options was wrong. No request was made, and none will be. */
export class CafayeConfigurationError extends CafayeError {
  /** Which configuration source was consulted, when that is knowable. */
  readonly source: string | null;

  constructor(message: string, options: { source?: string; cause?: unknown } = {}) {
    super(message, { kind: 'configuration', status: null, cause: options.cause });
    this.name = 'CafayeConfigurationError';
    this.source = options.source ?? null;
  }
}

/** A per-field failure. Present on a 422 and nowhere else, per core. */
export interface CafayeFieldError {
  /** The request field that failed. */
  readonly field: string;
  /** A stable slug, safe to switch on. */
  readonly code: string;
}

/**
 * An RFC 9457 problem document, as a thrown value.
 *
 * Every string the document contributed has been through the redactor before it
 * got here, including the extension members and the per-field `errors`. That is
 * the mechanism behind "a token string appears in no … thrown object's
 * serialised form": a service that echoes a caller's own credential back inside
 * `detail` produces an exception whose `detail` is `[redacted: …]`, not a
 * credential in a log line four frames later.
 */
export class CafayeProblemError extends CafayeError {
  /** `https://errors.cafaye.com/<code>` — the machine-readable contract. */
  readonly type: string;
  /** A fixed human-readable summary for the code. */
  readonly title: string;
  /** Specific to this occurrence, and not parsed by clients. */
  readonly detail: string;
  /** The request path. Never includes the query string, which can carry an address. */
  readonly instance: string;
  /** The last segment of `type`, in snake_case. Absent if the service omitted it. */
  readonly code: string | null;
  /** Always equal to the `X-Trace-Id` response header, and where support starts. */
  readonly traceId: string | null;
  /** Per-field failures. Only ever present on a 422. */
  readonly errors?: readonly CafayeFieldError[];
  /** Every member that is not one of the eight the fleet defines. */
  readonly extensions: Readonly<Record<string, unknown>>;
  /** The service and operation the call was made through, for the log line. */
  readonly operation: string | null;

  constructor(
    message: string,
    details: {
      type: string;
      title: string;
      status: number;
      detail?: string;
      instance?: string;
      code?: string | null;
      traceId?: string | null;
      errors?: readonly CafayeFieldError[];
      extensions?: Record<string, unknown>;
      operation?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { kind: 'problem', status: details.status, cause: details.cause });
    this.name = 'CafayeProblemError';
    this.type = details.type;
    this.title = details.title;
    this.detail = details.detail ?? '';
    this.instance = details.instance ?? '';
    this.code = details.code ?? null;
    this.traceId = details.traceId ?? null;
    if (details.errors !== undefined) this.errors = details.errors;
    this.extensions = Object.freeze({ ...(details.extensions ?? {}) });
    this.operation = details.operation ?? null;
  }
}

/** 401. The credential was absent, expired or revoked — core's `unauthorized`. */
export class CafayeUnauthenticatedError extends CafayeProblemError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeUnauthenticatedError';
  }
}

/** 403. The credential is valid and not enough. core's `forbidden`. */
export class CafayeForbiddenError extends CafayeProblemError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeForbiddenError';
  }
}

/**
 * 404. core is careful about this one: "Never 404 for authorization failures on
 * a resource the caller cannot see — 404 is correct there, 403 is not allowed to
 * leak existence." So a 404 from identity can mean "not a member of that account"
 * and not only "no such account", and a caller must not read it either way.
 */
export class CafayeNotFoundError extends CafayeProblemError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeNotFoundError';
  }
}

/** 429. core's `rate_limited`. */
export class CafayeRateLimitedError extends CafayeProblemError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeRateLimitedError';
  }
}

/** 409. core's `conflict`. */
export class CafayeConflictError extends CafayeProblemError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeConflictError';
  }
}

/**
 * 409 `idempotency_key_reused` — the same key with a different body.
 *
 * A subclass of `CafayeConflictError` rather than a sibling, because it is one:
 * "Replay with the same key but a different body returns 409
 * `idempotency_key_reused`", and a caller retrying a conflict has to check this
 * one specifically before retrying anything, because the retry cannot succeed.
 */
export class CafayeIdempotencyKeyReusedError extends CafayeConflictError {
  constructor(message: string, details: ConstructorParameters<typeof CafayeProblemError>[1]) {
    super(message, details);
    this.name = 'CafayeIdempotencyKeyReusedError';
  }
}

/** 422 `validation_failed`, with the per-field failures core documents for it. */
export class CafayeValidationError extends CafayeProblemError {
  /** Present on a validation failure; core says `errors[]` appears only on a 422. */
  declare readonly errors: readonly CafayeFieldError[];

  constructor(
    message: string,
    details: ConstructorParameters<typeof CafayeProblemError>[1] & {
      errors?: readonly CafayeFieldError[];
    },
  ) {
    super(message, { ...details, errors: details.errors ?? [] });
    this.name = 'CafayeValidationError';
  }
}

/**
 * An HTTP response that is not what the contract says it is.
 *
 * `problemShaped` says which of the two edges this is: a failure that did not
 * arrive as a problem document, or a success that did. The `status` is always a
 * number here, because there was always a response — that is the difference from
 * `CafayeNetworkError` and the reason this is not a subclass of it.
 */
export class CafayeProtocolError extends CafayeError {
  /** The `Content-Type` the service sent, or `null` if it sent none. */
  readonly contentType: string | null;
  /** Whether the body looked like a problem document but was not usable as one. */
  readonly problemShaped: boolean;
  /** A redacted, truncated excerpt. Absent when redaction removed all of it. */
  readonly bodySnippet: string | null;
  /** The service and operation the call was made through. */
  readonly operation: string | null;

  constructor(
    message: string,
    options: {
      status: number;
      contentType?: string | null;
      problemShaped?: boolean;
      bodySnippet?: string | null;
      operation?: string | null;
      cause?: unknown;
    },
  ) {
    super(message, { kind: 'protocol', status: options.status, cause: options.cause });
    this.name = 'CafayeProtocolError';
    this.contentType = options.contentType ?? null;
    this.problemShaped = options.problemShaped ?? false;
    this.bodySnippet = options.bodySnippet ?? null;
    this.operation = options.operation ?? null;
  }
}

/**
 * No HTTP response arrived.
 *
 * `status` is `null` — inherited, not overridden — and that is the whole point of
 * keeping it on the base class. `reason` is what makes a timeout and a DNS
 * failure different problems rather than the same one with different timings.
 */
export class CafayeNetworkError extends CafayeError {
  /** Which network failure this was. */
  readonly reason: NetworkFailureReason;
  /** The underlying platform error code, when Node provided one. */
  readonly code: string | null;

  constructor(
    message: string,
    options: { reason: NetworkFailureReason; code?: string | null; cause?: unknown },
  ) {
    super(message, { kind: 'network', status: null, cause: options.cause });
    this.name = 'CafayeNetworkError';
    this.reason = options.reason;
    this.code = options.code ?? null;
  }
}

/**
 * The request was given up on because it took too long.
 *
 * A subclass of `CafayeNetworkError` rather than a sibling, and the reason to say
 * so here rather than leave it implied: "the service did not answer in time" and
 * "the name did not resolve" are both retryable, and only the second is worth
 * retrying immediately. `catch (e) { if (e instanceof CafayeTimeoutError) … }`
 * separates them without the caller knowing that Node reports one as a
 * `DOMException` named `TimeoutError` and the other as a `TypeError: fetch failed`
 * with `cause.code`.
 */
export class CafayeTimeoutError extends CafayeNetworkError {
  /** The timeout this client applied, in milliseconds, when it applied one. */
  readonly timeoutMs: number | null;

  constructor(
    message: string,
    options: { timeoutMs?: number | null; code?: string | null; cause?: unknown },
  ) {
    super(message, { reason: 'timeout', code: options.code ?? null, cause: options.cause });
    this.name = 'CafayeTimeoutError';
    this.timeoutMs = options.timeoutMs ?? null;
  }
}

/**
 * Is this a cafaye error, including one thrown by a different copy of this
 * package?
 *
 * `instanceof` alone is not enough. Two copies of `cafaye-ts` in one dependency
 * tree — a monorepo with a workspace link beside an installed version, a
 * transitive duplicate — give two distinct `CafayeError` constructors, and
 * `instanceof` returns false for an error thrown across the boundary. The failure
 * is silent and looks like a bug in the consumer's error handling, which is the
 * worst place to go looking for the cause. The registered symbol below is the
 * cross-realm equivalent, and it is what this function checks.
 */
export function isCafayeError(value: unknown): value is CafayeError {
  return (
    value instanceof CafayeError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[ERROR_BRAND] === true)
  );
}

/**
 * Work out why a request failed without producing a response.
 *
 * A pure function of the rejection value, and that is a deliberate constraint
 * rather than an accident of factoring: the interesting cases are a timeout
 * versus an abort versus a name that did not resolve, and the only way to test
 * all three without a socket, a DNS server and a timer is to hand it the three
 * error shapes Node produces and assert what comes back.
 *
 * The shapes it recognises, and where they were observed (Node 22, undici):
 *
 *   timeout     `DOMException` named `TimeoutError`, code 23. This is what
 *               `AbortSignal.timeout` produces, and undici rejects with the
 *               reason itself rather than wrapping it.
 *   aborted     `DOMException` named `AbortError`, code 20 — the caller's own
 *               signal, or a composed one where the caller's side fired.
 *   dns         `TypeError: fetch failed` with `cause.code` of `ENOTFOUND` or
 *               `EAI_AGAIN`. The message is always the same useless `fetch
 *               failed`, which is precisely why the code has to be dug out of the
 *               cause.
 *   connection  `ECONNREFUSED`, `ECONNRESET`, `EHOSTUNREACH`, `ENETUNREACH`,
 *               `EPIPE`, `UND_ERR_SOCKET`.
 *   tls         a certificate or handshake code, which is a different problem
 *               again: it is a configuration fault, not a blip, and retrying it
 *               is how an outage becomes an incident.
 */
export function classifyNetworkFailure(error: unknown): {
  reason: NetworkFailureReason;
  code: string | null;
} {
  const named = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  // Strings only, and the reason is worth stating: the one place a numeric code
  // appears is a `DOMException`'s legacy `code` — 20 for AbortError, 23 for
  // TimeoutError — and both of those are already identified by `name` a line
  // below. Coercing them to strings would put `23` in a field documented as a
  // platform error code, where it reads like a Node errno.
  const topLevel = typeof named?.code === 'string' ? named.code : null;
  const fromCause = typeof named?.cause?.code === 'string' ? named.cause.code : null;
  const code = topLevel ?? fromCause;

  // `AbortSignal.timeout` rejects undici with its reason directly, so the
  // timeout arrives as a DOMException in its own right rather than wrapped in a
  // TypeError. undici's own connect/header/body timeouts are code-shaped
  // instead, so both spellings are here.
  if (
    named?.name === 'TimeoutError' ||
    (code !== null && /^UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT$/.test(code))
  ) {
    return { reason: 'timeout', code };
  }
  if (named?.name === 'AbortError') return { reason: 'aborted', code };
  if (code !== null && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')) {
    return { reason: 'dns', code };
  }
  if (
    code !== null &&
    /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|EADDRNOTAVAIL|EACCES|UND_ERR_SOCKET)$/.test(
      code,
    )
  ) {
    return { reason: 'connection', code };
  }
  // The certificate and handshake faults Node and OpenSSL actually produce.
  // `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and `EPROTO` are in the list because they
  // are the two that carry no obvious keyword, and a wrapper that called a
  // broken certificate chain "connection" would tell a caller to retry it.
  if (code !== null && /(CERT|LEAF_SIGNATURE|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|SSL_|EPROTO)/.test(code)) {
    return { reason: 'tls', code };
  }
  return { reason: 'unknown', code };
}

/**
 * The classes a problem's `code` maps to, and the statuses used when it has
 * none. Stated as data rather than as a switch so that the mapping is one
 * readable table and the fallback is visible next to it.
 */
const PROBLEM_CLASSES: Readonly<Record<string, typeof CafayeProblemError>> = {
  unauthorized: CafayeUnauthenticatedError,
  forbidden: CafayeForbiddenError,
  not_found: CafayeNotFoundError,
  rate_limited: CafayeRateLimitedError,
  conflict: CafayeConflictError,
  idempotency_key_reused: CafayeIdempotencyKeyReusedError,
  validation_failed: CafayeValidationError,
};

const STATUS_CLASSES: Readonly<Record<number, typeof CafayeProblemError>> = {
  401: CafayeUnauthenticatedError,
  403: CafayeForbiddenError,
  404: CafayeNotFoundError,
  409: CafayeConflictError,
  422: CafayeValidationError,
  429: CafayeRateLimitedError,
};

/**
 * Does this body look like an RFC 9457 problem document?
 *
 * Structural, and deliberately so: `type` and `title` are the two members RFC
 * 9457 requires, `status` is what every cafaye service repeats, and requiring
 * three of them means an arbitrary JSON error body from a gateway does not get
 * mistaken for a contract. The check is on the body rather than on the
 * `Content-Type`, because a mislabelled content type behind a proxy is common
 * and the body is the thing that decides what a caller has to handle.
 */
export function looksLikeProblem(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === 'string' &&
    typeof (value as { title?: unknown }).title === 'string' &&
    typeof (value as { status?: unknown }).status === 'number'
  );
}

/** Everything a `CafayeProblemError` needs, gathered from a body and a response. */
export interface ProblemInput {
  /** The parsed body, if it parsed. */
  readonly body: unknown;
  /** The HTTP status the response carried. */
  readonly status: number;
  /** The `Content-Type` the response carried, or `null`. */
  readonly contentType?: string | null;
  /** `service.operation`, for the message. */
  readonly operation?: string | null;
  /** Credential values to keep out of the message and out of every member. */
  readonly secrets?: readonly string[];
}

/**
 * Build the right exception for a problem document.
 *
 * `code` chooses the class and `status` breaks the tie, for the reason in the
 * file header: `code` is the documented machine-readable contract and `status`
 * is one response's opinion about itself.
 */
export function problemErrorFrom(input: ProblemInput): CafayeProblemError {
  const redact = createRedactor(input.secrets ?? []);
  const body = (looksLikeProblem(input.body) ? input.body : {}) as Record<string, unknown>;

  const code = typeof body.code === 'string' ? redact(body.code) : null;
  const status = typeof body.status === 'number' ? body.status : input.status;

  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_PROBLEM_MEMBERS.has(key)) continue;
    extensions[key] = redactValue(redact, value);
  }

  const fieldErrors = Array.isArray(body.errors)
    ? body.errors.map((entry) => {
        const field = (entry as { field?: unknown })?.field;
        const entryCode = (entry as { code?: unknown })?.code;
        return {
          field: typeof field === 'string' ? redact(field) : '',
          code: typeof entryCode === 'string' ? redact(entryCode) : '',
        };
      })
    : undefined;

  const title = redact(typeof body.title === 'string' ? body.title : 'Request failed');
  const detail = redact(typeof body.detail === 'string' ? body.detail : '');
  const type = redact(typeof body.type === 'string' ? body.type : 'about:blank');
  const instance = redact(typeof body.instance === 'string' ? body.instance : '');
  const traceId = typeof body.trace_id === 'string' ? redact(body.trace_id) : null;
  const operation = input.operation ?? null;

  const Klass =
    (code !== null ? PROBLEM_CLASSES[code] : undefined) ??
    STATUS_CLASSES[status] ??
    CafayeProblemError;

  const where = operation === null ? '' : `${operation}: `;
  const message = redact(
    `${where}${status}${code === null ? '' : ` ${code}`} — ${title}${detail === '' ? '' : `: ${detail}`}`,
  );

  return new Klass(message, {
    type,
    title,
    status,
    detail,
    instance,
    code,
    traceId,
    ...(fieldErrors === undefined ? {} : { errors: fieldErrors }),
    extensions,
    operation,
  });
}

/** Redact every string inside an extension value, without losing its shape. */
function redactValue(redact: (value: unknown) => string, value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(redact, entry));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(redact, v)]),
    );
  }
  return value;
}

/**
 * Build the exception for a response that broke the contract in either
 * direction.
 *
 * The body excerpt is kept because a reverse proxy's HTML 502 is otherwise
 * undiagnosable from the client side, and dropped entirely when redaction
 * removed all of it — `redact` returns one marker for the whole string, so
 * `snippet === REDACTED` means "there was something credential-shaped in there
 * and none of it is going in an exception".
 */
export function protocolErrorFrom(input: {
  status: number;
  contentType?: string | null;
  bodyText: string;
  problemShaped: boolean;
  operation?: string | null;
  secrets?: readonly string[];
}): CafayeProtocolError {
  const redact = createRedactor(input.secrets ?? [], 200);
  const where = input.operation === null || input.operation === undefined ? '' : `${input.operation}: `;

  if (input.status >= 200 && input.status < 300) {
    return new CafayeProtocolError(
      redact(
        `${where}HTTP ${input.status} carried an application/problem+json body, which core's ` +
          `conventions reserve for failures. Treating it as a success would hand the caller a ` +
          `problem document where its types promised a result, so this is thrown instead. ` +
          `The service is not following its own contract.`,
      ),
      {
        status: input.status,
        contentType: input.contentType ?? null,
        problemShaped: input.problemShaped,
        operation: input.operation ?? null,
      },
    );
  }

  const redacted = redact(input.bodyText);
  return new CafayeProtocolError(
    redact(
      `${where}HTTP ${input.status} did not return an RFC 9457 problem document` +
        (input.contentType === null || input.contentType === undefined
          ? ' (no Content-Type)'
          : ` (Content-Type: ${input.contentType})`) +
        '. Something between this client and the service answered — a proxy, a gateway, ' +
        'a rate limiter — so there is no problem document to map and no cafaye code to ' +
        'branch on.',
    ),
    {
      status: input.status,
      contentType: input.contentType ?? null,
      problemShaped: input.problemShaped,
      // `REDACTED` means the whole excerpt went, so there is nothing left worth
      // showing and a marker in a `bodySnippet` field would only be noise.
      bodySnippet: redacted === '' || redacted === REDACTED ? null : redacted,
      operation: input.operation ?? null,
    },
  );
}
