# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the runtime code. The main entrypoints remain `src/index.ts`, `src/cli.ts`, and `src/bot.ts`, while larger subsystems now live in focused subdirectories: `src/bot/` holds Telegram transport/rendering/state/prompt helpers plus grouped command handlers under `src/bot/commands/`, and `src/install/` holds installed-mode config, extension, launchd, and shared install helpers. Core session/model/voice logic still lives in top-level modules such as `src/pi-session.ts`, `src/model-scope.ts`, `src/tree.ts`, and `src/voice.ts`. `test/` mirrors that structure: top-level integration suites such as `test/bot.test.ts`, `test/install.test.ts`, and `test/pi-session.test.ts` are backed by focused unit suites under `test/bot/`. Integration assets live beside the app: `extensions/telepi-handoff.ts` for Pi CLI hand-off, `launchd/com.telepi.plist` for macOS service setup, and `Dockerfile` plus `docker-compose.yml` for containerized runs.

## Build, Test, and Development Commands
Use `npm install` to install dependencies. `npm run dev` starts TelePi with `tsx` against `src/index.ts` for local development. `npm run build` compiles TypeScript into `dist/`. `npm start` runs the built app from `dist/index.js`. `npm test` runs the Vitest suite once, and `npm run test:coverage` enforces coverage thresholds. For Docker, use `docker compose up --build` after creating `.env`.

## Operational Commands
For the installed macOS `launchd` flow, rebuild from the repo root with `npm run build`. Restart the installed bot with `launchctl kickstart -k gui/$UID/com.telepi`. Check installed-mode status with `node dist/cli.js status` (or `telepi status` when the global CLI is on `PATH`). Installed-mode logs live under `~/Library/Logs/TelePi/`.

## Coding Style & Naming Conventions
This project uses strict TypeScript with ESM modules. Follow the existing style: 2-space indentation, double quotes, semicolons, and explicit `.js` import suffixes in TypeScript source. Prefer small, focused modules in `src/` and keep filenames lowercase with hyphens only when already established, for example `pi-session.ts` and `model-scope.ts`. Export named functions and types where practical; avoid default exports unless there is a clear single entrypoint.

## Testing Guidelines
Tests use Vitest with `globals: true` and the pattern `test/**/*.test.ts`. Add or update tests alongside behavior changes, especially for bot command/callback flows, prompt streaming, install/setup behavior, parsing, formatting, session flow, and voice fallback logic. Prefer small unit suites in `test/bot/` or other focused folders when extracting helpers, and keep `test/bot.test.ts` and `test/install.test.ts` as regression-heavy integration coverage. Coverage thresholds are enforced at 85% for lines, functions, and statements and 75% for branches; `src/index.ts` and `src/install.ts` are excluded from coverage accounting because they mainly act as orchestration/facade entrypoints.

## Commit & Pull Request Guidelines
Recent history favors short imperative subjects, usually Conventional Commit style: `fix: support switching TelePi sessions by id`, `feat(docker): allow user npm global installs`. Prefer `feat`, `fix`, and optional scopes when useful. PRs should explain the user-visible change, note any config or deployment impact (`.env`, Docker, `launchd`), link related issues, and include screenshots or chat transcripts when Telegram UX changes.

## Security & Configuration Tips
Keep secrets in `.env`; never commit bot tokens or Pi auth files. `TELEGRAM_ALLOWED_USER_IDS` is required and should stay narrowly scoped. In Docker, preserve the read-only mounts for `~/.pi/agent/auth.json` and `settings.json`, and treat `/workspace` as the only writable agent workspace.

## Release Automation
This fork must not publish `@futurelab-studio/telepi` or create release tags. Do not follow the upstream tag-push flow in this fork. Deliver verified source on `feat/pi-1.1.0` only; the default branch remains upstream until separately accepted. Preserve the upstream package name, version, MIT license, and LICENSE attribution.

npm publishing belongs only to upstream `benedict2310/TelePi`. The entire `.github/workflows/release.yml` release job is guarded by `github.repository == 'benedict2310/TelePi'`, including npm publishing and GitHub Release assets. Upstream uses npm Trusted Publishing (no `NPM_TOKEN`) with `npx --yes npm@11.10.0`; the retained upstream-only playbook is `docs/npm-trusted-publishing.md`, not a fork release procedure.
