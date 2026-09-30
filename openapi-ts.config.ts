// The generation pipeline's only configuration.
//
//   npm run generate      # regenerate all six services from specs/*.yaml
//   npm run generate -- identity    # just one
//
// WHY THIS FILE READS specs/index.json INSTEAD OF NAMING SIX INPUTS
//
// A hardcoded path per service is the specific bug this repository is built to
// avoid. MD6 measured the fleet with a glob that matched files *named* `openapi*`
// and found "almost no machine-readable API surface" — it missed every document
// living at `openapi/v1.yaml` and had to correct the finding. courier's document
// is at its repository ROOT rather than at `openapi/v1.yaml`, so any loop that
// assumed the conventional path skips courier and produces a five-of-six client
// that reports success.
//
// So there is no list of services anywhere in this repository. The index is the
// list, this file maps it, and `test/regeneration.test.mjs` re-runs the whole
// pipeline and diffs it. Adding a service is one entry in specs/index.json; the
// configuration, the pipeline, and the provenance test all follow without anyone
// editing a second file and risking the two disagreeing.
//
// WHY THE SERVICE LIST DRIVES THE GENERATOR BUT NOT THE PUBLIC API
//
// MD6's structural ruling is that generated code stays an internal detail behind
// a hand-written surface, so a generator upgrade can never break the public API.
// That surface is `src/index.ts`, and it is deliberately NOT derived from this
// list. Nothing here re-exports anything; the generated tree is reachable
// through its own subpath exports and, after cafaye-ts-02, through the `Cafaye`
// class. If this file also chose the public API, a document rename upstream would
// become a breaking change here, which is the lock-in MD6 rules out.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from '@hey-api/openapi-ts';

const ROOT = import.meta.dirname;
const index = JSON.parse(readFileSync(path.join(ROOT, 'specs', 'index.json'), 'utf8'));

/**
 * Plugin list, stated rather than inherited.
 *
 * hey-api's default is exactly `['@hey-api/typescript', '@hey-api/sdk']`, and its
 * own documentation notes that defining `plugins` yourself means the defaults are
 * gone. Writing them out is one extra line and it means a future change to
 * hey-api's defaults cannot silently add a plugin to a committed, published
 * artifact. The output of this file is reviewed in a diff; the inputs to this
 * file should be too.
 *
 * `@hey-api/typescript` emits the types. `@hey-api/sdk` emits the per-service
 * transport — the functions that build a request, serialise it and return the
 * response. Those two together are MD6's "generated types and per-service
 * transport"; the hand-written wrapper above them is packet 2's job, not this
 * file's.
 */
const PLUGINS = ['@hey-api/typescript', '@hey-api/sdk'] as const;

/**
 * The HTTP client.
 *
 * `@hey-api/client-fetch` makes the generator COPY the fetch client's source into
 * the output rather than emit an import of a published package. That is the whole
 * reason `dependencies` in package.json is `{}`: the generated transport runs on
 * the platform's own `fetch` and brings nothing with it. A different client
 * (`-axios`, `-ky`, `-ofetch`) would reintroduce a runtime dependency, so this
 * line is load-bearing for MD6's zero-dependency requirement and is asserted by
 * `test/no-runtime-dependencies.test.mjs`, which walks every generated import
 * specifier and fails on one that is not relative and not a Node builtin.
 */
const CLIENT = '@hey-api/client-fetch';

/** One entry in specs/index.json, as this file needs to read it. */
interface IndexService {
  service: string;
  spec: string;
  infoVersion: string;
  repository: string;
  commit: string;
}

/** One generated service. */
function serviceConfig(service: IndexService) {
  return {
    input: path.join(ROOT, service.spec),
    output: {
      path: path.join(ROOT, 'src', 'services', service.service),
      // No formatter and no linter in the post-process chain. Both would be
      // another tool whose version decides the bytes of a committed artifact, and
      // `test/regeneration.test.mjs` would then be asserting that a formatter plus
      // a generator is deterministic rather than that the generator is. The
      // generator's own emitter is already consistent; adding a formatter buys
      // cosmetics and spends the property this repository exists to keep.
      postProcess: [],
      // Each service directory gets an `index.ts` re-exporting its own generated
      // modules, so `cafaye-ts/services/identity` resolves to one directory
      // rather than asking a consumer to know the emitter's internal file names.
      entryFile: true,
      // A header on every generated file saying what generated it, from what, and
      // how to change it. Written out rather than left to the emitter's default
      // because the two things a reader of a generated file needs are which
      // document it came from and which commit that document was taken at — and
      // the second one is only knowable here, where the index entry is in scope.
      // It is provenance carried into the artifact, which is the whole point.
      header: () => [
        '/* eslint-disable */',
        '// Generated by @hey-api/openapi-ts. DO NOT EDIT.',
        `// Source: ${service.spec}`,
        `//         ${service.service}, document version ${service.infoVersion},`,
        `//         vendored from ${service.repository}`,
        `//         at commit ${service.commit}`,
        '// Regenerate: npm run generate',
        '//            test/regeneration.test.mjs proves regeneration is a no-op,',
        '//            and that a hand-edit here is reverted by it.',
      ],
    },
    client: CLIENT,
    plugins: PLUGINS,
  };
}

export default defineConfig((index.services as IndexService[]).map(serviceConfig));
