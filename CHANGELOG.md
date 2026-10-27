# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-27

### Added

- One-click **CoT** header button backed by the authenticated exact Fetch route
  `GET /api/cot.export`.
- `/cot` slash command with `json`, `surface`, `latest`, `<id-or-prefix>` and
  `review [focus]` variants.
- `cot_export` and `cot_review` agent tools; `cot_review` writes `REVIEW.md`
  with the review rubric, a window plan and a ready-to-pass delegation prompt.
- Embedded `cot-review` skill so any session can load the same rubric.
- Markdown (frontmatter + turn index), JSON, JSONL and plain-text formats.
- Compaction-hidden reasoning is preserved and marked `superseded`; fork-inherited
  steps are marked `inherited`; descendant subagent sessions can be exported as a
  tree with an `INDEX.md`.
- Configurable output directory, format, scope, cross-session policy, route path
  and skill toggle.
- Aggregate-bundle double-mount guard in `cordis.patch.yml`.

### Packaging

- Standard Cordis bundle manifest (`dsh.bundle.patch`) with Host and Client
  halves, locale dictionaries and an icon.
- 16 unit tests running on `node --test` with no installed dependencies.
- GitHub Actions CI (Node 22.19 / 24) and tag-driven GitHub Release that attaches
  the packed `.tgz`.
