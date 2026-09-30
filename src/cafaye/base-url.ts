// One place that decides where requests go.
//
// The generated clients do not decide: each carries a documented default
// `baseUrl` naming its service's public SaaS host. That default is a trap rather
// than a convenience, and `README.md` already says so — "There is deliberately no
// pre-built client to grab … a self-hoster who reached for it would send their
// traffic to the public SaaS." MD6 gives the wrapper this job for the same
// reason it gives it credential handling: the fleet's documents cannot express a
// self-hoster's deployment, so something hand-written has to.
//
// THE PRECEDENCE, HIGHEST FIRST
//
//   1. `baseUrl` as a record, the entry for this service
//   2. `baseUrl` as a string, which applies to all six
//   3. `CAFAYE_<SERVICE>_BASE_URL`
//   4. `CAFAYE_BASE_URL`
//   5. the host's own origin, `globalThis.location.origin`
//   6. throw
//
// Explicit beats ambient, and within a source the more specific beats the less.
// Steps 1 and 2 are one option in two shapes: a consumer who wrote six URLs meant
// them, so the per-service entry wins. Steps 3 and 4 are one source in two
// granularities for the same reason.
//
// THE PER-SERVICE NAME IS DERIVED, not written out six times.
//
// `baseUrlEnvFor('identity')` composes `CAFAYE_IDENTITY_BASE_URL` from the
// service name. Six string literals would be a second list of the six services
// next to `specs/index.json` and the namespace imports, and this repository is
// organised entirely around not having those: "`specs/` is the only place a
// service's OpenAPI path appears … That is the whole design: there is no second
// place to update, so there is no second place to forget."
//
// WHY THE HOST'S ORIGIN IS LAST
//
// It is the weakest statement of intent available — "wherever this code happens
// to be running" — and it is genuinely right in exactly one situation: a browser
// application served from the same origin as the fleet, where the `__Host-session`
// cookie is same-origin and the bearer header is a fallback rather than the point.
// A Node server has no `location` at all, and one that reached this step is
// misconfigured.
//
// WHY THERE IS NO LOCALHOST, AND WHY THE SIXTH STEP IS A THROW
//
// The brief: "a test that resolution never silently defaults to localhost in a
// way a consumer would not notice." A localhost default is attractive for
// exactly the wrong reason — it would make a developer's laptop work — and it is
// a silent misdirection everywhere else: a production process that resolved to
// `http://localhost:3000` would fail with a connection refused against a service
// nobody asked for, and the error would name the wrong thing.
//
// So the sixth step throws, and the error names every source it consulted. The
// generated client's SaaS default is never reachable from here, which is the
// property that makes this file worth existing at all.

import { CafayeConfigurationError } from './errors.js';

/** The environment variable that applies to every service. */
export const BASE_URL_ENV = 'CAFAYE_BASE_URL';

/** The six services, as a name — the only list in the source that is not a type. */
export type ServiceName = 'identity' | 'billing' | 'muse' | 'darkroom' | 'pantry' | 'courier';

/**
 * `CAFAYE_IDENTITY_BASE_URL` and so on, derived.
 *
 * @throws {CafayeConfigurationError} for a name that is not one of the six,
 *   because an unknown service means somebody typed a service that does not
 *   exist, and quietly resolving a base URL for it would be the kind of
 *   tolerance that hides a typo until a 404 from a proxy.
 */
export function baseUrlEnvFor(service: string): string {
  if (!/^[a-z]+$/.test(service)) {
    throw new CafayeConfigurationError(
      'A cafaye service name is lower-case ASCII. Refusing to derive an environment ' +
        'variable name from anything else, because a name that cannot be one is a name ' +
        'that does not identify a cafaye service.',
      { source: service },
    );
  }
  return `CAFAYE_${service.toUpperCase()}_BASE_URL`;
}

/** A `baseUrl` option: one origin for everything, or one per service. */
export type BaseUrlOption = string | Partial<Record<ServiceName, string>>;

/** What `resolveBaseUrl` was given, and what it may fall back to. */
export interface BaseUrlSources {
  /** The `baseUrl` option, if the caller passed one. */
  readonly explicit?: BaseUrlOption;
  /**
   * The environment to read. Passed in rather than read from `process.env` here
   * so this function is pure — but the `Cafaye` class passes the live
   * `process.env` object on every call, so a variable set after the package was
   * imported is still seen. A module that snapshotted the environment at import
   * time would pass every test in this file and then be wrong in a Next.js
   * server, a test harness and every container runtime.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The host's own origin, when there is one. Defaults to
   * `globalThis.location?.origin`, read per call for the same reason as above.
   */
  readonly hostOrigin?: string | null;
}

/** Trim, and treat blank as absent. An empty base URL is not a base URL. */
function present(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Is this an absolute http(s) URL?
 *
 * A bare host is refused rather than completed. `identity.example.com` would
 * otherwise be concatenated by the generated client into
 * `identity.example.com/v1/me`, which is not a URL at all, and the resulting
 * failure names neither the typo nor the cause.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * Strip trailing slashes so the URL this reports is the URL that goes out.
 *
 * The generated client concatenates rather than resolving — `getUrl` in each
 * service's `core/utils.gen.ts` is `(baseUrl ?? '') + pathUrl` — so a trailing
 * slash becomes a doubled separator in the path. Its `mergeConfigs` strips one;
 * this strips all of them and keeps a path prefix, which a self-hoster serving
 * the fleet under `/cafaye` needs and which `URL` would helpfully but wrongly
 * delete if this used `new URL(value).origin`.
 */
function normalise(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Where requests to one service go.
 *
 * @throws {CafayeConfigurationError} when nothing is configured, or when what is
 *   configured is not an absolute http(s) URL. The message names every source
 *   that was consulted, in the order they were consulted, and never suggests a
 *   host.
 */
export function resolveBaseUrl(service: ServiceName, sources: BaseUrlSources = {}): string {
  const env = sources.env ?? {};
  const candidates: Array<{ value: string | null; source: string }> = [];

  if (typeof sources.explicit === 'string') {
    candidates.push({ value: present(sources.explicit), source: 'the `baseUrl` option' });
  } else if (sources.explicit !== undefined) {
    const perService = present(sources.explicit[service]);
    const perServiceEnv = baseUrlEnvFor(service);
    candidates.push({ value: perService, source: `the \`baseUrl.${service}\` option` });
    candidates.push({ value: present(env[perServiceEnv]), source: `$${perServiceEnv}` });
    candidates.push({ value: present(env[BASE_URL_ENV]), source: `$${BASE_URL_ENV}` });
  } else {
    const perServiceEnv = baseUrlEnvFor(service);
    candidates.push({ value: present(env[perServiceEnv]), source: `$${perServiceEnv}` });
    candidates.push({ value: present(env[BASE_URL_ENV]), source: `$${BASE_URL_ENV}` });
  }

  const hostOrigin =
    sources.hostOrigin === undefined
      ? ((globalThis as { location?: { origin?: unknown } }).location?.origin as string | undefined)
      : sources.hostOrigin;
  candidates.push({
    value: present(typeof hostOrigin === 'string' ? hostOrigin : null),
    source: "the host's own origin (globalThis.location.origin)",
  });

  const chosen = candidates.find((candidate) => candidate.value !== null);
  const perServiceEnv = baseUrlEnvFor(service);

  if (chosen === undefined || chosen.value === null) {
    throw new CafayeConfigurationError(
      `No base URL is configured for ${service}, and this package will not guess one. ` +
        `Set one of, in order: the \`baseUrl\` option (a string for every service, or a ` +
        `record with a \`${service}\` key), $${perServiceEnv}, $${BASE_URL_ENV}, or run ` +
        `this code on the origin that serves cafaye. Each of those is a decision somebody ` +
        `made; a default would be a guess, and a guess about which deployment to send a ` +
        `customer's credentials to is the one kind of guess this package refuses to make.`,
      { source: `base URL for ${service}` },
    );
  }

  if (!isAbsoluteHttpUrl(chosen.value)) {
    throw new CafayeConfigurationError(
      `The base URL from ${chosen.source} is not an absolute http(s) URL. cafaye's own ` +
        `generated clients concatenate the base URL with the operation's path rather than ` +
        `resolving one against the other, so a bare host would produce something that is ` +
        `not a URL and an error that names neither the value nor the cause. Give an ` +
        `absolute URL including the scheme.`,
      { source: chosen.source },
    );
  }

  return normalise(chosen.value);
}
