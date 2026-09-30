// The hand-written half of the client, and the four jobs MD6 gives it.
//
// MD6, quoted: "Structure: generated types and per-service transport, wrapped by
// one hand-written client. … A single hand-written `Cafaye` class owns
// credential handling, base-URL resolution for self-hosting, and RFC 9457
// problem-to-exception mapping. Generated code stays an implementation detail,
// so a generator upgrade can never break the public API — which is precisely the
// lock-in that just killed Stainless."
//
// So this file is the wrapper, and the generated tree is an implementation
// detail of it. `new Cafaye({ baseUrl })` is the whole of what a consumer has to
// write, and every operation on every service is reached through a property
// whose type came out of a document.
//
// FOUR JOBS, IN THE ORDER THEY HAPPEN TO A REQUEST
//
//   1. Where does it go?           `base-url.ts` — resolved once, in the
//      constructor, and a misconfiguration throws before a request exists.
//   2. What proves who you are?    `credentials.ts` — attached per request, from
//      current state, so a rotated credential takes effect on the next call.
//   3. How long will we wait?      an `AbortSignal` composed per request.
//   4. What went wrong?            `errors.ts` — the envelope the generated
//      transport returns becomes an exception, or a value.
//
// WHY THE CREDENTIAL IS ATTACHED PER REQUEST AND NOT PER CLIENT
//
// The obvious implementation puts the header in `createClient({ headers })` once.
// It is cheaper and it is wrong for the case this package exists to serve: a
// long-lived Node process holds a credential that expires, and a client that
// captured it at construction cannot be given a new one without being thrown
// away. `setCredentials` exists for that, and it is why the attachment happens in
// a `requestValidator` — the hook the generated client calls with the fully
// merged options, immediately before it builds the `Request`.
//
// WHY A `requestValidator` AND NOT AN INTERCEPTOR
//
// The generated client also offers request interceptors, which receive a
// `Request`. They are the wrong tool here: reconstructing a `Request` to change
// its headers re-wraps the body, and a body that is a stream rather than a
// string makes that a `TypeError` about `duplex`. The generated code serialises
// bodies to strings, so it would not bite today — but the failure would be in
// the transport, on a body this file never touches, for a reason that has
// nothing to do with the header being set. The validator mutates `opts.headers`
// in place, which is the same object the transport then uses.
//
// WHY THE CREDENTIAL GOES ON EVERY REQUEST
//
// The obvious refinement is to attach it only to operations whose document
// declares a security scheme, which the generated transport already knows how to
// read. It is also measurably wrong for this fleet: `grep` over the six vendored
// documents finds per-operation `security` arrays on eleven identity operations
// and six courier operations, and NONE on billing, muse, darkroom or pantry —
// muse and darkroom state their security globally, which the generator does not
// copy onto each operation, and billing and pantry state `security: []` with a
// note. A client that respected the per-operation arrays would silently send
// unauthenticated requests to four of six services, and the failure would be a
// 401 from a service rather than an error from the client.
//
// So: the credential goes on every request. What a service does with it is the
// service's business, and the fleet's own documents are careful about what each
// one accepts.
//
// NOTHING IS LOGGED
//
// This file does not write to a logger, to `console`, to `process.stdout`, or to
// a telemetry endpoint, and it never will. The brief's constraint is "Never log
// a token, a cookie, or a JWT. Not at debug level, not in an error message, not
// in a thrown exception's message", and the only way to guarantee that for a
// library is to emit nothing: a debug-level log is a log level somebody turns
// off in production and a log level somebody pastes into a bug report.
// `test/wrapper-credential-leak.test.mjs` asserts both halves — that no output
// is produced, and that a credential appears in no message, no own property and
// no serialised form of anything thrown.

import { resolveBaseUrl, type BaseUrlOption, type ServiceName } from './base-url.js';
import { attachCredential, classifyCredential, type CredentialKind } from './credentials.js';
import {
  CafayeConfigurationError,
  CafayeError,
  CafayeNetworkError,
  CafayeTimeoutError,
  classifyNetworkFailure,
  looksLikeProblem,
  problemErrorFrom,
  protocolErrorFrom,
} from './errors.js';
import { createRedactor, safeCause } from './redact.js';
import { clientFactories, namespaces, serviceNames, type ServiceClient } from './services.js';

/**
 * The default request timeout, in milliseconds.
 *
 * A judgement call the brief did not make, so here is the reasoning. A client
 * with no timeout can hang for as long as the platform's own socket timeout
 * allows, which for a keep-alive connection is a long time, and a caller that
 * wanted a 200 gets an unresolved promise instead. Thirty seconds is long enough
 * that no operation in the six documents — all of which are ordinary request/
 * response, with no streaming and no long polling — would ever reach it, and
 * short enough that a wedged service is reported as a failure rather than
 * inherited by the next caller. Set `timeoutMs: 0` to disable it.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** How long a body excerpt is kept on a protocol error, in characters. */
const BODY_SNIPPET_LENGTH = 200;

const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** What the generated transport hands back, as far as this file cares. */
interface Envelope {
  readonly data?: unknown;
  readonly error?: unknown;
  readonly response?: Response;
}

/**
 * The data member of a generated result envelope, with the error arm removed.
 *
 * The `Promise` is unwrapped and the conditional distributes over the result
 * union, which is what drops the `{ data: undefined, error }` arm. Two things
 * make this more than a one-liner, and both were found by compiling a probe
 * rather than by reading the type:
 *
 *   - The generated operations are generic in `ThrowOnError extends boolean`, and
 *     inferring a signature from outside erases that parameter to its CONSTRAINT,
 *     not its default. `boolean extends true ? … : …` then distributes over
 *     `true | false` and yields BOTH the throwing and the envelope branch. Taking
 *     `data` from either gives the same type, so the union collapses — but only
 *     because this distributes, and a non-distributive version returns a union of
 *     a value and `never` that looks fine and is not.
 *
 *   - The success arm of a non-2xx-free operation is `{ data, request,
 *     response }` with the last two REQUIRED, and the error arm has them
 *     optional. The intersection means `NonNullable` is doing real work: without
 *     it the two arms would contribute `T` and `never`, and `T | never` is `T`,
 *     which is right by accident rather than by construction.
 */
type DataOf<R> = R extends Promise<infer P> ? (P extends { data: infer D } ? NonNullable<D> : never) : never;

/** The options a generated operation takes, with the ones this class owns removed. */
type OwnedOptionKeys = 'client' | 'throwOnError' | 'responseStyle' | 'baseUrl' | 'auth';

/**
 * One generated operation, bound to a client and narrowed to its success shape.
 *
 * The generated signature returns the envelope — `{ data, error, request?,
 * response? }` — and offers `throwOnError: true` as the way to get a
 * non-optional `data`. Both are declined here. `throwOnError` throws whatever
 * `JSON.parse` produced, which is a bare object rather than an `Error` and
 * carries no stack; and the envelope is a second thing to destructure at every
 * call site, which is the friction the wrapper exists to remove. So the bound
 * operation returns the data, and a failure is a typed exception.
 *
 * Optionality is read from the parameter rather than assumed. Half the generated
 * operations are `(options?: …)` and half are `(options: …)` — `getCurrentUser`
 * takes none, `getCustomer` requires a path — and a wrapper that made them all
 * optional would let a caller forget a path parameter, and one that made them all
 * required would force `await cafaye.muse.routeCompletion()` to be written
 * `({})`. `[undefined] extends [O]` is the test that tells the two apart, and it
 * is checked in that direction deliberately: the other direction,
 * `[O] extends [undefined]`, is also true for a required parameter under
 * `noUncheckedIndexedAccess`, which this repository turns on.
 */
export type BoundOperation<F> = F extends (options: infer O) => infer R
  ? [undefined] extends [O]
    ? (options?: Omit<NonNullable<O>, OwnedOptionKeys>) => Promise<DataOf<R>>
    : (options: Omit<O, OwnedOptionKeys>) => Promise<DataOf<R>>
  : never;

/**
 * A generated namespace with every operation bound to a client.
 *
 * The `as` key filter drops everything that is not a function, which at runtime
 * is only the operations — a namespace's types are erased, so a `type` export is
 * not a runtime export to bind — and in the type is what keeps a stray non-
 * function out of the wrapped object.
 */
export type BoundNamespace<M> = {
  readonly [K in keyof M as M[K] extends (...args: never[]) => unknown ? K : never]: BoundOperation<M[K]>;
};

/** The six service namespaces, each with its operations bound. */
export interface CafayeServices {
  readonly identity: BoundNamespace<typeof namespaces.identity>;
  readonly billing: BoundNamespace<typeof namespaces.billing>;
  readonly courier: BoundNamespace<typeof namespaces.courier>;
  readonly darkroom: BoundNamespace<typeof namespaces.darkroom>;
  readonly muse: BoundNamespace<typeof namespaces.muse>;
  readonly pantry: BoundNamespace<typeof namespaces.pantry>;
}

/** What a caller hands the constructor. */
export interface CafayeOptions {
  /**
   * Where requests go. A string applies to all six services; a record names them
   * individually and its per-service entries win. Left out, the environment and
   * then the host's own origin are consulted, and if neither produces an
   * absolute http(s) URL the constructor throws. See `base-url.ts` for the full
   * order.
   */
  readonly baseUrl?: BaseUrlOption;
  /**
   * The credential: a scoped API token (`cafaye_` plus 32 bytes), a session token
   * from `POST /v1/session`, or a bearer JWT. Which one it is decides where it
   * is sent, and the class works it out from the shape rather than being told —
   * see `credentials.ts` for the discriminator and the reason it is identity's.
   */
  readonly credentials?: { readonly token: string };
  /**
   * How long one request may take, in milliseconds. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}. `0` disables the timeout and leaves the
   * platform's own behaviour in place.
   */
  readonly timeoutMs?: number;
  /**
   * The `fetch` to use. Defaults to the platform's. This is the seam the test
   * suite drives; it is also how a consumer supplies an instrumented or
   * proxy-aware client.
   */
  readonly fetch?: typeof fetch;
  /** Headers to send with every request, e.g. a tracing header. */
  readonly headers?: Readonly<Record<string, string>>;
}

const PROBLEM_MEDIA_TYPE_PATTERN = /^application\/problem\+json\b/i;

/** Is this `Content-Type` the one core reserves for failures? */
function isProblemContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mediaType = contentType.split(';')[0] ?? '';
  return PROBLEM_MEDIA_TYPE_PATTERN.test(mediaType.trim());
}

/** The text of a body the transport could not parse as JSON. */
function bodyTextOf(error: unknown): string {
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? '';
  } catch {
    // A body with a cycle in it cannot be stringified, and failing to diagnose a
    // proxy's response is a worse outcome than not quoting it.
    return '';
  }
}

/**
 * The `Cafaye` class: one constructor, six service namespaces, typed failures.
 *
 * ```ts
 * const cafaye = new Cafaye({ baseUrl: 'https://cafaye.example.com' });
 * const user = await cafaye.identity.getCurrentUser();
 * ```
 */
export class Cafaye {
  /** The `identity` operations, bound to a client. Generated underneath. */
  readonly identity: BoundNamespace<typeof namespaces.identity>;
  /** The `billing` operations, bound to a client. Generated underneath. */
  readonly billing: BoundNamespace<typeof namespaces.billing>;
  /** The `courier` operations, bound to a client. Generated underneath. */
  readonly courier: BoundNamespace<typeof namespaces.courier>;
  /** The `darkroom` operations, bound to a client. Generated underneath. */
  readonly darkroom: BoundNamespace<typeof namespaces.darkroom>;
  /** The `muse` operations, bound to a client. Generated underneath. */
  readonly muse: BoundNamespace<typeof namespaces.muse>;
  /** The `pantry` operations, bound to a client. Generated underneath. */
  readonly pantry: BoundNamespace<typeof namespaces.pantry>;

  /** Where each of the six services is pointed, after resolution. */
  readonly baseUrls: Readonly<Record<ServiceName, string>>;

  /** The current credential's kind, or `null` when there is no credential. */
  #credential: string | null = null;
  #credentialKind: CredentialKind | null = null;
  readonly #timeoutMs: number;
  readonly #clients = new Map<ServiceName, unknown>();

  constructor(options: CafayeOptions = {}) {
    const env: Readonly<Record<string, string | undefined>> =
      typeof process === 'undefined' ? {} : process.env;

    // Resolved for all six, here, rather than on first use. A base URL that
    // cannot be resolved is a deployment mistake, and the moment to say so is
    // before anything is sent rather than on the sixth call.
    const baseUrls = {} as Record<ServiceName, string>;
    for (const service of serviceNames) {
      baseUrls[service] = resolveBaseUrl(service, { explicit: options.baseUrl, env });
    }
    this.baseUrls = Object.freeze(baseUrls);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
      // A negative or NaN timeout would make `AbortSignal.timeout` throw inside
      // the transport on the first request, hours after the mistake that caused
      // it, as a TypeError that names neither the option nor the value.
      throw new CafayeConfigurationError(
        '`timeoutMs` must be a non-negative finite number of milliseconds. A negative or ' +
          'non-finite value would make every request fail inside the platform rather than in ' +
          'this constructor, where the mistake is. Use 0 to disable the timeout.',
        { source: 'timeoutMs' },
      );
    }
    this.#timeoutMs = timeoutMs;

    if (options.credentials !== undefined) this.setCredentials(options.credentials);

    const built = {} as Record<ServiceName, unknown>;
    for (const service of serviceNames) {
      built[service] = this.#build(service, options);
    }

    this.identity = built.identity as CafayeServices['identity'];
    this.billing = built.billing as CafayeServices['billing'];
    this.courier = built.courier as CafayeServices['courier'];
    this.darkroom = built.darkroom as CafayeServices['darkroom'];
    this.muse = built.muse as CafayeServices['muse'];
    this.pantry = built.pantry as CafayeServices['pantry'];
  }

  /**
   * What kind of credential this instance holds, or `null` if it holds none.
   *
   * The value is deliberately not exposed. A consumer that wants to know whether
   * it handed over an API token or a session token gets the answer; a consumer
   * that wants to read the token back out of its own client does not, because the
   * moment an object can hand the credential out is the moment it ends up in a log
   * through some code path nobody was thinking about.
   */
  get credentialKind(): CredentialKind | null {
    return this.#credentialKind;
  }

  /**
   * Replace the credential, or remove it with `null`.
   *
   * It takes effect on the next request, which is the point: a process that
   * outlives a token needs to hand over a new one, and a client that captured its
   * credential at construction cannot be given one.
   */
  setCredentials(credentials: { readonly token: string } | null): void {
    if (credentials === null) {
      this.#credential = null;
      this.#credentialKind = null;
      return;
    }
    // Classified before anything is stored, so a credential that would break a
    // header is refused by the setter rather than by a request three hours later.
    const kind = classifyCredential(credentials.token);
    this.#credential = credentials.token;
    this.#credentialKind = kind;
  }

  /**
   * The generated client for one service, with this class's base URL and
   * credential already on it.
   *
   * The escape hatch, and it exists for a specific gap MD6 names: courier's
   * document is partial by its own header, so
   * `/v1/notification_preferences/:user_id` is not in the generated client even
   * though courier serves it. `rawClient` reaches it.
   *
   * The cost is stated in the name: **errors from here are not typed.** The
   * generated transport's own envelope comes back — `{ error, response }` — with
   * no `CafayeError` anywhere in it. Use the bound namespaces for everything the
   * documents describe, and this for the routes they do not.
   */
  rawClient<S extends ServiceName>(service: S): ServiceClient<S> {
    const client = this.#clients.get(service);
    if (client === undefined) {
      throw new CafayeError(`No client for ${String(service)}`, { kind: 'configuration', status: null });
    }
    return client as ServiceClient<S>;
  }

  /**
   * Build one service's client and bind its operations to it.
   *
   * The cast is here, once, and it is the price of six generated clients with six
   * structurally identical but nominally distinct types. Everything above this
   * line works in terms of the generated namespaces; the alternative to the cast
   * is six copies of these four lines, which is the shape drift takes.
   */
  #build(service: ServiceName, options: CafayeOptions): unknown {
    const timeoutMs = this.#timeoutMs;

    /**
     * Per-request cleanup, keyed by the signal this class installed.
     *
     * Two things have to be undone when a request finishes: a pending timer, and
     * a listener this file put on the caller's `AbortSignal`. Neither grows
     * without bound — the timer is unref'd, so it cannot hold a process open —
     * but "at most one request's worth" is a much easier property to reason about
     * than "whatever the request rate happens to be", and a listener left on a
     * long-lived `AbortController` that a caller keeps reusing is a real one.
     *
     * A `WeakMap` rather than a `Map` because a missed cleanup should cost a
     * garbage collection and not a leak: the entry dies with the signal.
     */
    const cleanups = new WeakMap<AbortSignal, () => void>();

    const config = {
      baseUrl: this.baseUrls[service],
      throwOnError: false as const,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
      requestValidator: async (data: unknown) => {
        // `ResolvedRequestOptions` in everything but name: `headers` is a merged,
        // freshly-built `Headers` and `signal` is whatever the caller passed, if
        // anything. Reading both per request rather than capturing them is what
        // makes `setCredentials` work and what gives every request its own
        // deadline rather than one deadline for the client's lifetime.
        const opts = data as { headers: Headers; signal?: AbortSignal | null };
        attachCredential(opts.headers, this.#credential);

        if (timeoutMs === 0) return;

        /**
         * One controller, two things that can abort it, and a reason that says
         * which.
         *
         * `AbortSignal.any` was the first version of this and it is subtly wrong
         * in a way the tests found: `any` adopts the reason from whichever signal
         * fired, so a caller who aborts with an error of their own — which is the
         * documented way to say why they stopped — produces a rejection this class
         * cannot classify, because an arbitrary `Error` is indistinguishable from
         * a network failure. Owning the controller fixes it: the caller's side
         * aborts with a sentinel this file recognises and the deadline aborts with
         * a `CafayeTimeoutError`, so both are already typed by the time the
         * rejection arrives and neither has to be guessed at afterwards.
         */
        const controller = new AbortController();
        const callerSignal = opts.signal ?? undefined;
        // The caller's abort reason is a value the CALLER chose, and it arrives
        // here on its way to becoming a `cause` — so it goes through the same
        // redactor as everything else, at the same time, rather than being trusted
        // because it came from inside the process.
        const safe = createRedactor(this.#credential === null ? [] : [this.#credential]);

        const onCallerAbort = () => {
          controller.abort(
            new CafayeNetworkError(
              `${service}: the request was stopped by the caller's own signal, not by this ` +
                "client's deadline. Nothing about the service is implied by that, and it must " +
                'not be retried by anything that does not know whose signal it was.',
              { reason: 'aborted', cause: safeCause(callerSignal?.reason, safe) },
            ),
          );
        };

        if (callerSignal !== undefined) {
          if (callerSignal.aborted) onCallerAbort();
          else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        }

        const timer = setTimeout(() => {
          controller.abort(
            new CafayeTimeoutError(
              `${service}: no response within ${timeoutMs}ms. The request was given up on; ` +
                'nothing about the service is implied by that, and a timeout is not a DNS ' +
                'failure — check `reason` before retrying.',
              { timeoutMs, cause: safeCause(callerSignal?.reason, safe) },
            ),
          );
        }, timeoutMs);
        // Unref'd so a pending deadline cannot hold a process open. A library that
        // keeps a Node process alive for thirty seconds after its last request is a
        // library that breaks every graceful-shutdown test in the application using
        // it.
        timer.unref?.();

        const signal = controller.signal;
        cleanups.set(signal, () => {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
        });
        opts.signal = signal;
      },
    };

    const factory = clientFactories[service] as (config: unknown) => unknown;
    const client = factory(config) as {
      interceptors: {
        response: {
          fns: Array<((r: Response, q: Request, o: { signal?: AbortSignal }) => Response) | undefined>;
        };
        error: { fns: Array<((e: unknown) => unknown) | undefined> };
      };
    };

    // Both hooks, and each must RETURN its first argument: the generated
    // transport assigns the hook's result back over the response or the error
    // (`response = await fn(response, request, opts)`), so a hook that returns
    // `undefined` silently replaces a perfectly good response with nothing. That
    // is not a hypothetical — it is what the first version of this did, and every
    // request in the test suite failed as a network error with `[object Object]`
    // for its message.
    //
    // The response hook receives the RESOLVED options, so the signal it reads is
    // the one this file installed. The error hook receives the original per-call
    // options, whose `signal` is the caller's own — so cleanup does not run on that
    // path. That is a missed optimisation and not a leak, and reading the wrong
    // signal to "fix" it would tear down a request that is still wanted.
    const clearOnResponse = (
      response: Response,
      _request: Request,
      opts: { signal?: AbortSignal | undefined },
    ) => {
      if (opts?.signal !== undefined) cleanups.get(opts.signal)?.();
      return response;
    };
    const clearOnError = (error: unknown) => error;
    client.interceptors.response.fns.push(clearOnResponse);
    client.interceptors.error.fns.push(clearOnError);

    this.#clients.set(service, client);
    return this.#bind(service, client);
  }

  /**
   * Wrap every function in a generated namespace.
   *
   * A namespace is a module object whose runtime exports are its operations, so
   * this is a map over `Object.entries` with one wrapper. It is not a `Proxy`,
   * which would keep the generated names invisible to a consumer's editor — and
   * MD6's stated reason for having a hand-written half at all is that "a
   * generator upgrade can never break the public API", which is a promise about
   * what a consumer can see.
   */
  #bind(service: ServiceName, client: unknown): unknown {
    const namespace = namespaces[service] as Record<string, unknown>;
    const bound: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(namespace)) {
      if (typeof value !== 'function') continue;
      const operation = value as (options: unknown) => Promise<unknown>;
      bound[name] = async (options?: unknown) => {
        const envelope = (await operation({
          ...(typeof options === 'object' && options !== null ? options : {}),
          client,
          throwOnError: false,
        })) as Envelope;
        return this.#unwrap(envelope, `${service}.${name}`);
      };
    }

    return Object.freeze(bound);
  }

  /**
   * Turn the generated envelope into a value or a typed exception.
   *
   * The four outcomes, in the order they are decided:
   *
   *   no response at all            a `CafayeNetworkError`, or a
   *                                 `CafayeTimeoutError` if the reason says so
   *   a response that failed        a `CafayeProblemError` if the body is one,
   *                                 otherwise a `CafayeProtocolError`
   *   a 2xx carrying a problem      a `CafayeProtocolError` — this is the
   *                                 "a problem-shaped body with a 200 is not a
   *                                 success" rule
   *   a 2xx carrying anything else  the data
   */
  #unwrap(envelope: Envelope, operation: string): unknown {
    const secrets = this.#credential === null ? [] : [this.#credential];
    const response = envelope.response;

    if (envelope.error !== undefined && envelope.error !== null) {
      throw this.#errorFor(envelope.error, response, operation, secrets);
    }

    const contentType = response?.headers.get('content-type') ?? null;

    if (response !== undefined && !response.ok) {
      // A failure that produced no error value. The generated transport guards
      // this with `finalError = finalError || {}`, so it cannot happen against
      // this tree; if it ever does, a protocol error is the honest description,
      // because a status is known and nothing about the failure is.
      throw protocolErrorFrom({
        status: response.status,
        contentType,
        bodyText: '',
        problemShaped: false,
        operation,
        secrets,
      });
    }

    // Either signal is enough, and both are checked. A service that returns a
    // problem document labelled `application/json` is still returning a problem
    // document, and handing its body back as a success value is the one outcome a
    // typed client must never produce — that is the brief's "a problem-shaped
    // body with a 200 is not a success". Nothing in the six documents' success
    // schemas has `type`, `title` and `status` together, so the structural check
    // has no false positive against the current fleet.
    if (isProblemContentType(contentType) || looksLikeProblem(envelope.data)) {
      throw protocolErrorFrom({
        status: response?.status ?? 0,
        contentType,
        bodyText: bodyTextOf(envelope.data),
        problemShaped: looksLikeProblem(envelope.data),
        operation,
        secrets,
      });
    }

    return envelope.data;
  }

  /** The one place a failure becomes an exception. */
  #errorFor(
    error: unknown,
    response: Response | undefined,
    operation: string,
    secrets: readonly string[],
  ): CafayeError {
    // No response means the request never produced one: DNS, a refused
    // connection, a certificate, a timeout, or a caller's own abort. The
    // distinction is in `reason`, and it is not collapsed.
    if (response === undefined) {
      // An error this class constructed is already typed, already redacted and
      // already carries the right `reason` — it is the abort sentinel or the
      // deadline's own error, travelling through undici as the signal's reason.
      // Wrapping it again would replace a `reason: 'aborted'` with whatever
      // `classifyNetworkFailure` could work out from the outside, and an
      // arbitrary caller-supplied abort reason is not classifiable at all.
      if (error instanceof CafayeError) return error;

      const { reason, code } = classifyNetworkFailure(error);
      const safe = createRedactor(secrets);
      const detail = error instanceof Error ? error.message : String(error);
      return new CafayeNetworkError(
        safe(
          `${operation}: ${reason === 'unknown' ? 'the request failed' : `the request failed (${reason})`}` +
            `${code === null ? '' : ` [${code}]`}: ${detail}`,
        ),
        // The cause is kept when it is clean, because it is where the errno is,
        // and withheld entirely when it is not. A `cause` is an object Node prints
        // in `console.error(err)` and in every crash reporter, and a partially
        // scrubbed copy would be a cause that is no longer the platform's carrying
        // a message that is no longer true.
        { reason, code, cause: safeCause(error, safe) },
      );
    }

    const contentType = response.headers.get('content-type');
    if (looksLikeProblem(error)) {
      return problemErrorFrom({
        body: error,
        status: response.status,
        contentType,
        operation,
        secrets,
      });
    }
    return protocolErrorFrom({
      status: response.status,
      contentType,
      bodyText: bodyTextOf(error),
      problemShaped: false,
      operation,
      secrets,
    });
  }
}
