# Marketplace submission — awesome-dsh-plugin

Draft for the PR that lists opencode2dsh in the dsh-market catalog
([awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)).
Format verified against that repo's `contributing.md` (2026-08-29).

## The entry file

Add exactly one file: `data/plugins/FishBottle7__opencode2dsh--packages-plugin.yml`
(monorepo subpackage entry; filename = `<owner>__<repo>--packages-plugin.yml`).

```yaml
url: https://github.com/FishBottle7/opencode2dsh/tree/master/packages/plugin
name: FishBottle7/opencode2dsh#plugin
category: model
description:
  en: Exposes OpenCode Zen free models to DeepSeek Harness, with no API key.
  zh: 将 OpenCode Zen 免费模型接入 DeepSeek Harness，无需 API Key。
```

Notes on the wording (their review rules):

- `description.en` is the only required field; `zh` included for convenience.
- Description states what it does, no superlatives, ends with a period.
  Quoted because it contains a colon; the `''` escapes the apostrophe in YAML.
- Category `model` (registers an LLM provider route); a maintainer may re-file.

## Pre-submission checklist (CI checks these)

- [ ] Repo public on GitHub, pushed, **older than 1 day** with **>= 10 commits**
      (we have 15+ commits; just mind the 1-day age after creating the repo).
- [ ] `dsh.bundle` manifest reachable **from the URL the entry points at**:
      the root `package.json` declares no `dsh.bundle`, so the entry must
      point at the `packages/plugin` subpackage (tree/master URL + `#plugin`
      name + `--packages-plugin.yml` filename), where
      `dsh.bundle.patch: ./cordis.patch.yml` is declared. Verified in review:
      pointing the entry at the repo root fails with
      "root package.json declares no dsh.bundle".
- [ ] Add the GitHub topic **`dsh-plugin`** to the repo (repo page → gear next to About).
- [ ] `npm publish --access public` in `packages/plugin` first — npm installs skip
      the build-approval step in the market. The published package's
      `repository` field must point back at the listed repo (already set).
- [ ] Optional: `screenshots.json` next to `packages/plugin/package.json` with
      1-8 image paths (relative, images committed to the repo) for the
      AppStore-style detail view. Without it, the market extracts images from
      the README.

## Steps

```sh
# 1. fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
# 2. in the fork:
npm ci
# 3. add data/plugins/FishBottle7__opencode2dsh.yml with the content above
node scripts/generate-readme.mjs
# 4. commit the YAML + both regenerated READMEs, open the PR
```

## PR title

```
Add FishBottle7/opencode2dsh (model)
```

## PR body

```markdown
Adds one entry: `data/plugins/FishBottle7__opencode2dsh.yml`.

**What it does** — registers a native DSH `LlmAdapter` that streams from
OpenCode Zen's free endpoint (`Authorization: Bearer public`), so the
free models (big-pickle, hy3-free, ...) appear in the model picker without
any API key. Catalog comes from the live `/v1/models` list
intersected with models.dev free-by-metadata, falling back to a disk cache
and a verified static list; the plugin auto-refreshes and writes a health
snapshot to `~/.opencode2dsh/adapter-status.json`.

**Install source** — published to npm as
[`@opencode2dsh/dsh-plugin`](https://www.npmjs.com/package/@opencode2dsh/dsh-plugin);
its `repository` field points back at the listed repo.

**Manifest** — `packages/plugin/package.json` declares
`dsh.bundle: { patch: "./cordis.patch.yml" }` (adapter-only; the legacy Go
sidecar lives in `legacy/` and is not shipped).

- Repo: https://github.com/FishBottle7/opencode2dsh
- License: MIT
```
