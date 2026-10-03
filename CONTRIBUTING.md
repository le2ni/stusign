# Contributing

## Development

Use Node.js 22.18+ and the pnpm version declared in package.json.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

Source is in `src/`; `tsdown.config.ts` defines the ESM entry points. The root and transport declarations must stay usable without DOM types. Keep rendering and crypto implementation dependencies in their optional entry points.

`pnpm test` and `pnpm test:coverage` work before building. Vitest resolves public `stusign` imports in examples to source entry points. Keep those aliases in sync when adding an export. The separate `check:package` script validates the compiled exports from an npm archive after building.

`pnpm check` runs formatting, strict TypeScript, unit/integration tests, tsdown/publint, example type checks, README snippet compilation, documentation link checks in the repository and npm archive, and packed consumers under NodeNext and Bundler resolution. CI runs the same checks plus `python3 scripts/test-stu-serial-to-hid.py` for the optional Mac maintenance utility. These checks do not connect to hardware or publish anything.

Use `pnpm format` before submitting changes. Add regression tests for protocol, state-machine, framing and crypto behavior; synthetic fixtures must be identified as such. Do not infer device support from a passing mock.

## Hardware qualification

Use `pnpm hardware` and the [guided procedure](docs/stu-540-hardware-test.md). Confirm tablet output against the preview and instructions; do not convert command success into a visual pass. Put local exports under ignored `hardware-reports/`. Do not commit signature strokes, PINs, device serials, screenshots of personal documents, browser storage or session notes.

Tests and reusable example source belong in the repository. Generated `dist/`, coverage, example bundles, tarballs, Python caches and local reports are ignored. The report-size fixtures retain protocol lengths only.

## Public API and protocol changes

Update the [API reference](docs/api.md), [support matrix](docs/support-matrix.md) and [protocol evidence](docs/protocol-evidence.md) when behavior changes. The README's quick-start TypeScript must match `examples/basic/app.ts`; `check:docs` enforces this and type-checks every TypeScript block in the README.

Unknown packet IDs are not permission to write guessed payloads. New features need primary protocol evidence and appropriate device qualification. No Wacom SDK binaries, firmware blobs or copied SDK source may be added as a shortcut to native/TLS support.

## Publishing

Publishing a GitHub release runs the `Publish` workflow. It checks out the release's tagged commit, validates the version, runs all checks and publishes the built archive to npm with provenance. Draft releases and tag pushes alone do not publish.

Configure **Trusted Publisher → GitHub Actions** once in the npm package settings:

| Setting              | Value         |
| -------------------- | ------------- |
| Organization or user | `le2ni`       |
| Repository           | `stusign`     |
| Workflow filename    | `publish.yml` |
| Environment          | Leave blank   |
| Allow `npm publish`  | Enabled       |

The workflow uses OIDC authentication; no npm token secret is required. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

Update `package.json` and `CHANGELOG.md`, commit and push, then publish a GitHub release whose tag matches the package version, such as `v0.1.1` (or `0.1.1`). Stable versions publish to `latest`. For a prerelease, use a version such as `0.2.0-rc.1` and mark the GitHub release as a prerelease; it publishes to `next`. A mismatched version or prerelease flag fails before publishing. Each release needs a new version; published npm versions cannot be overwritten.

`pnpm pack` builds a local tarball. Manual publishing remains available through `pnpm publish --access public --publish-branch main` with a maintainer npm account. Its `prepublishOnly` hook runs the full check suite and `prepack` rebuilds the output. The release workflow runs these checks before publishing its archive.

MIT licensing applies to this implementation. Preserve the LICENSE and NOTICE files. Dependencies retain their own licenses.
