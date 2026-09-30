// The one place that knows what a vendored OpenAPI document is and how to
// measure it. `scripts/vendor.mjs`, `scripts/verify-specs.mjs` and the tests all
// import these functions rather than each growing its own copy, because a
// measurement that is computed two ways is a measurement that will be reported
// two ways.
//
// MD6's own lesson applies here and is worth repeating, because this is the
// exact bug it describes: a glob that matches files *named* `openapi*` finds
// every document at a repository root and misses every document that lives at
// `openapi/v1.yaml`. MD6's first pass found "almost no machine-readable API
// surface" for precisely that reason, and had to correct itself. The six
// services here are listed by name, not discovered by glob — a hardcoded path
// per service is a real risk, and the index carries an `expectOperations` field
// so that a service whose document moved or changed size fails loudly instead
// of being skipped.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import yaml from 'js-yaml';

const require = createRequire(import.meta.url);

/** Repository root, resolved from this file rather than from process.cwd(). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Where the provenance index lives, relative to the repository root. */
export const INDEX_PATH = path.join(REPO_ROOT, 'specs', 'index.json');

/**
 * The OpenAPI path-item keys that are operations.
 *
 * An allowlist, not a denylist, and the distinction is load-bearing. A path item
 * also carries `summary`, `description`, `parameters`, `servers` and `$ref`, and
 * `counting every key that is not obviously a field` would count all five as
 * operations. `query` is an OpenAPI 3.2 addition; it is listed so that a
 * document that adopts it is not silently undercounted, and it costs nothing
 * while every document in the fleet is 3.1.
 */
export const HTTP_METHODS = Object.freeze([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
  'query',
]);

/** A full, unabbreviated git object name. Provenance is a rumour without it. */
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Read the provenance index.
 *
 * Throws rather than returning a default: an index that does not exist is not a
 * reason to generate a client from nothing, and a caller that treated "no
 * index" as "no services" would produce an empty package and report success.
 */
export async function readIndex() {
  let raw;
  try {
    raw = await readFile(INDEX_PATH, 'utf8');
  } catch (cause) {
    throw new Error(`cannot read the provenance index at ${INDEX_PATH}: ${cause.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${INDEX_PATH} is not valid JSON: ${cause.message}`);
  }

  if (!Array.isArray(parsed.services) || parsed.services.length === 0) {
    throw new Error(`${INDEX_PATH} lists no services; a client generated from it would be empty`);
  }
  return parsed;
}

/** Write the index back, with the formatting this repository commits. */
export async function writeIndex(index) {
  await writeFile(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/** Absolute path to a service's vendored document. */
export function specPathFor(entry) {
  return path.join(REPO_ROOT, entry.spec);
}

/** The hex SHA-256 of a buffer, as `sha256sum` would print it. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Count the operations and the paths an OpenAPI document actually declares.
 *
 * This is a real YAML parse of a real document, never a regex and never a line
 * count, for the same reason the count lives in the index at all: the number
 * has to mean something. It throws on a document that does not parse, which is
 * the failure the brief cares about — a truncated or empty vendored copy must
 * fail here rather than quietly generate a client with no operations in it.
 */
export function measureDocument(text, { source } = {}) {
  const where = source ? ` (${source})` : '';
  let doc;
  try {
    doc = yaml.load(text);
  } catch (cause) {
    throw new Error(`${source ?? 'document'} is not parseable YAML${where}: ${cause.message}`);
  }

  if (doc === null || doc === undefined) {
    throw new Error(`${source ?? 'document'} parsed to nothing${where} — an empty vendored copy`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${source ?? 'document'} is not an OpenAPI object${where}`);
  }
  if (typeof doc.openapi !== 'string') {
    throw new Error(
      `${source ?? 'document'} declares no \`openapi\` version${where} — it is not an OpenAPI document`,
    );
  }
  if (doc.paths === null || doc.paths === undefined) {
    throw new Error(`${source ?? 'document'} declares no \`paths\`${where} — nothing to generate`);
  }
  if (typeof doc.paths !== 'object' || Array.isArray(doc.paths)) {
    throw new Error(`${source ?? 'document'} has a \`paths\` that is not a mapping${where}`);
  }

  const methods = new Set(HTTP_METHODS);
  let operations = 0;
  let paths = 0;
  const byMethod = {};

  for (const [route, item] of Object.entries(doc.paths)) {
    if (item === null || typeof item !== 'object') {
      throw new Error(`${source ?? 'document'} path ${route} is not a path item${where}`);
    }
    let onPath = 0;
    for (const key of Object.keys(item)) {
      const method = key.toLowerCase();
      if (!methods.has(method)) continue;
      // A key can only be one operation, but `get: null` is a malformed
      // document rather than an operation, and counting it would overstate the
      // surface. The fleet's documents do not do this; asserting it is cheaper
      // than discovering it from a wrong number.
      if (item[key] === null || typeof item[key] !== 'object') {
        throw new Error(
          `${source ?? 'document'} declares \`${key}\` on ${route} with no operation body${where}`,
        );
      }
      byMethod[method] = (byMethod[method] ?? 0) + 1;
      onPath += 1;
    }
    if (onPath > 0) {
      paths += 1;
      operations += onPath;
    }
  }

  return {
    openapi: doc.openapi,
    infoVersion: typeof doc.info?.version === 'string' ? doc.info.version : null,
    title: typeof doc.info?.title === 'string' ? doc.info.title : null,
    operations,
    paths,
    byMethod,
  };
}

/** Read a vendored document from disk and measure it. */
export async function measureVendoredDocument(entry) {
  const file = specPathFor(entry);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (cause) {
    throw new Error(`vendored document for ${entry.service} is missing at ${file}: ${cause.message}`);
  }
  return {
    ...measureDocument(bytes.toString('utf8'), { source: `${entry.service} (${entry.spec})` }),
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

/** The hey-api version this repository generates with, for the tests to assert. */
export function installedGeneratorVersion() {
  return require('@hey-api/openapi-ts/package.json').version;
}
