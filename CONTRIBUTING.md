# Contributing to GYM

Thank you for helping. This page says how to get the code running, what a
change has to pass and how to send it.

## Before you start

- Read [docs/PRODUCT.md](docs/PRODUCT.md) for what the app is for and
  [docs/GLOSSARY.md](docs/GLOSSARY.md) for the binding vocabulary (cell, day
  protocol, block, skill, dataset, episode, …). Use these words in code, UI and
  docs, and do not introduce synonyms.
- [AGENTS.md](AGENTS.md) holds the rules of the codebase in short form (API and
  business logic are separate, every query is tenant-scoped, every stored byte
  goes through `lib/storage`, GYM never judges data itself, …). They apply to
  people as much as to coding agents.
- For anything larger than a bug fix, open an issue first and describe what
  you want to change and why. It saves you work that might not fit.

## Setup

```bash
git clone --recurse-submodules https://github.com/symbiosika/gym.git
```

The backend is built on the
[symbiosika-framework](https://github.com/symbiosika/symbiosika-framework),
checked out as a submodule in `backend/framework`. Changes to the framework go
to its own repository, never into this one.

The [README](README.md) covers the local setup (Bun, embedded PGlite, no
Docker needed) and the data critics. `critics/` has its own
[README](critics/README.md) for the Python side.

## Checks

Run what matches the part you changed, from that directory:

| Changed | Run |
|---|---|
| `backend/**` | `bun run test:local ./src` and `bun run typecheck` |
| `backend/src/db/schema.ts` | `bun run app:generate` and commit the migration |
| `frontend/**` | `bun run test`, `bun run type-check`, `bun run build-only`, `bun run format` |
| `critics/**` | `pytest -q` and `ruff check . && ruff format --check .` |

Every new route or piece of business logic comes with a test. CI runs the
same checks on every pull request.

## Style

- Code, comments and docs are in English. UI text lives in
  `frontend/src/locales/` (German and English, both kept in step).
- Match the surrounding code: naming, comment density, idiom.
- No em dashes or en dashes in UI text, docs or commit messages. Use `·`,
  commas or separate sentences.
- Colours live only in `frontend/src/assets/base.css`. Icons are components
  (`~icons/carbon/...`), never an icon font.

## Pull requests

- Branch from `develop` and open the pull request against `develop`.
- Keep a pull request to one concern. Describe what changed and why, and how
  you checked it.
- Commit messages say what the change does in plain sentences.
- By sending a contribution you agree that it is licensed under the
  [Apache License 2.0](LICENSE), the license of this repository.

## Reporting bugs and security issues

Bugs go into a GitHub issue with steps to reproduce. Security issues do not:
see [SECURITY.md](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
