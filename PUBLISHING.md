# Publishing

Checklist to ship `pi-minimal-claude` as a public, installable Pi package.

Repository: <https://github.com/SMicucci/pi-minimal-claude>

## 1. Pre-flight

```bash
npm install          # dev-only dependencies
npm run typecheck
npm test             # smoke (fake ExtensionAPI) + Pi loader parity
npm run publish:check:strict
```

`publish:check` validates the npm metadata, the `pi` manifest, the host
dependency layout and the exact `npm pack` contents (agents and extensions
included, `test/`, `scripts/` and `.pi/` excluded). `prepublishOnly` runs
typecheck, tests and the non-strict check on every `npm publish`.

Inspect the tarball once by hand:

```bash
npm pack --dry-run
```

## 2. Publish to npm

The name is unscoped, so it publishes public by default; `publishConfig.access`
is set for clarity.

```bash
npm login
npm publish --access public
```

Pinned install for users:

```bash
pi install npm:pi-minimal-claude@0.1.0
```

## 3. Install from git (no npm)

Tags are pinned by Pi, so tag every release:

```bash
git tag v0.1.0
git push origin main --tags
pi install git:github.com/SMicucci/pi-minimal-claude@v0.1.0
```

## 4. Own configuration

```bash
# personal install (~/.pi/agent/settings.json)
pi install npm:pi-minimal-claude@0.1.0

# project install (<project>/.pi/settings.json)
pi install -l npm:pi-minimal-claude@0.1.0

# one-shot try, no settings change
pi -e npm:pi-minimal-claude
```

When the package is installed from npm, remove any local `"packages": [".."]`
entry from the project's `.pi/settings.json`: two copies would load twice.

## 5. Gallery

`pi-package` is already in `keywords`, which makes the package eligible for
<https://pi.dev/packages>. Optional `pi.image` / `pi.video` fields add previews.
Nothing else is required.

## 6. Release flow

1. Bump `version` in `package.json` (`npm version patch|minor|major --no-git-tag-version`).
2. Update the changelog notes in the GitHub release.
3. `npm publish --access public`.
4. `git tag v<version> && git push origin main --tags`.
5. Users update with `pi update --extensions`.

## What must stay true

- Host-provided packages (`@earendil-works/pi-*`, `typebox`) only in
  `peerDependencies` with `"*"`, never in `dependencies`.
- `pi.extensions` and `pi.subagents.agents` point at files/directories that are
  inside `files`.
- `LICENSE` and `README.md` stay in the repository root (npm always includes
  them).
