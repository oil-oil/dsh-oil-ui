<p align="center">
  <img src="assets/readme/hero.en.webp" alt="dsh-oil-ui — Push DeepSeek's UI design to its limits." width="100%">
</p>

<p align="center">
  <a href="https://ui.oiloil.org/en">Showcase Gallery</a> ·
  <a href="https://ui.oiloil.org/en/pro/">Oil UI Pro</a> ·
  <a href="https://github.com/oil-oil/oil-ui">Upstream oil-ui</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#native-tools--slash-commands">Native Tools</a> ·
  <a href="README.md">中文文档</a>
</p>

---

**`dsh-oil-ui` is the native [oil-ui](https://github.com/oil-oil/oil-ui) plugin for DeepSeek Harness (`@deepseek-ai/dsh`).**

China mirror: [AtomGit](https://atomgit.com/oil-oil/dsh-oil-ui), synced from GitHub.

It brings the full `oil-ui` design workflow straight into DeepSeek Harness: explore 3 genuinely distinct first-screen directions side by side in a single comparison page, pick the strongest one, and refine the final interface against real browser screenshots, interactive step checks, and multi-viewport captures directly in your working directory.

For the core design workflow and live gallery, see the **[oil-ui repository](https://github.com/oil-oil/oil-ui)** and **[ui.oiloil.org/en](https://ui.oiloil.org/en)**. This README covers how `dsh-oil-ui` works inside DeepSeek Harness and how it pairs with **Oil UI Pro**.

<p align="center">
  <img src="assets/readme/showcase.en.webp" alt="Built autonomously by DeepSeek Harness + dsh-oil-ui" width="100%">
</p>

All 6 interfaces above (`ARCHON`, `Sonar`, `Tempo 2026`, `Atelier Volders`, `Fonderie Mercier`, and `Vesper`) were designed and built from scratch by `DeepSeek 4.1 Flash` + `dsh-oil-ui` in isolated workspaces from short text prompts—complete with 3-direction comparison pages, interactive states, and responsive checks.

---

## Why a Native Plugin

DeepSeek Harness already ships with native file tools (`read`, `write`, `edit`), shell execution (`bash`), image inspection (`read_image`), and subagents (`subagent`). Wrapping a separate project sandbox or an adapter layer on top forces the model to guess between duplicate file tools and nested directories.

`dsh-oil-ui` is built natively for DeepSeek Harness:

- **Works directly in `cwd`**: No hidden `projects/<uuid>` nesting. HTML, CSS, scripts, and screenshots live right in the current working directory alongside native `read`, `write`, and `read_image`.
- **Registers only the 5 specialized `oil-ui` tools**: Comparison page bundling, headless browser captures & interaction scripts, public-domain media search, AI image generation, and Skill status discovery.
- **Bundles the original public Skill**: Sync only published public `oil-ui` releases, preserving original bytes. Host tool guidance belongs in system prompts, tool descriptions, and the shared host section in `references/tools.md`.

---

## How It Runs in DeepSeek Harness

From a short prompt, the agent runs the full loop—**explore directions → bundle comparison page → build interactive interface → verify on real screenshots**:

<p align="center">
  <img src="assets/readme/proof-archon.webp" alt="ARCHON 3-direction comparison page in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="assets/readme/proof-tempo.webp" alt="Tempo 2026 3-direction mobile comparison page in DeepSeek Harness" width="100%">
</p>

1. Calls `oil_ui_skill_status` to inspect the model-visible Skill. When `skillReady=true`, it loads `activeSkillName` with the native skill tool. Bundled Lite, filesystem Lite, and Pro all use their original instructions; failures surface through `skillLoadWarning`.
2. Builds 3 distinct first-screen candidates in `explore/` and bundles them into a self-contained `style-explorer.html` via `oil_ui_explorer`.
3. Implements the chosen direction in `index.html` (and `screens.html` for multi-screen mobile flows), verifies states, interactions, and responsive viewports with `oil_ui_shoot`, and inspects every capture with `read_image`.

---

## Native Tools & Slash Commands

The plugin registers 5 tools, all resolved relative to the active session's working directory (`cwd`):

| Tool                  | What it does                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oil_ui_skill_status` | Refreshes Skill status and returns `activeSkillName`, image source, and oiloil balance; also checks for updates and handles the one-time Pro recommendation notice                                                                                                                                                                                                                                   |
| `oil_ui_explorer`     | Reads `explore/manifest.json` (normalizing common shorthand fields) and bundles candidate HTML files into a single interactive `style-explorer.html` comparison page                                                                                                                                                                                                                                 |
| `oil_ui_shoot`        | Captures real browser screenshots of local files or URLs: supports custom viewports, 2x zoom crops, multi-state captures (`states`), scripted interactions (`steps`), motion frame sequences (`frames`), optional recordings (`record` / `motion`), and normalized image comparisons (`stitch` items with `matchWidth` / `scale`, plus global `crop`), and built-in console/overflow/contrast checks |
| `oil_ui_media`        | Searches, previews, and downloads public-domain images, museum collections (Met, AIC, Cleveland, Wikimedia, Openverse), video clips, and map tiles                                                                                                                                                                                                                                                   |
| `oil_ui_image`        | Uses local `image-gen` first, then oiloil when unavailable; supports a requested resolution and reports the saved path when oiloil returns a different format                                                                                                                                                                                                                                        |

It also registers 3 `oil-ui-` slash commands in the composer (namespaced to avoid collisions with other `oil-*` Skills):

| Command                   | What it does                                                                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/oil-ui-status [update]` | Inspects the active Oil UI edition (`oil-ui` / `oil-ui-pro`), version update status, and `image-gen` availability; pass `update` for filesystem installs; bundled Lite requires a plugin update |
| `/oil-ui-explore <brief>` | Accepts optional reference attachments and queues a 3-direction exploration (`style-explorer.html`)                                                                                             |
| `/oil-ui-review [target]` | Accepts optional screenshot/file attachments and queues a two-track UI/UX review (visual hierarchy + task flow)                                                                                 |

---

## Oil UI Pro & Update Checks

`dsh-oil-ui` bundles the free `oil-ui` Skill out of the box. For production landing pages, dense product consoles, and multi-round visual polish, you can pair it with **[Oil UI Pro](https://ui.oiloil.org/en/pro/)**.

### What Oil UI Pro Adds

| Capability                                                                                       |         `oil-ui` (Bundled Free)          |                            `Oil UI Pro`                             |
| ------------------------------------------------------------------------------------------------ | :--------------------------------------: | :-----------------------------------------------------------------: |
| 3-direction exploration + `style-explorer.html` comparison page                                  |                    ✓                     |                                  ✓                                  |
| Screenshot-driven multi-round visual refinement & typography/contrast linting                    |                    —                     |                                  ✓                                  |
| Multi-state captures (`states`), scripted interactions (`steps`) & motion frame strips           |                    —                     |                                  ✓                                  |
| Museum/public-domain media (`oil_ui_media`) & AI image generation (`oil_ui_image`) playbooks     |                    —                     |                                  ✓                                  |
| Independent visual and UX walkthroughs                                                           | Lightweight UX walkthrough for key flows | Autonomous risk probes, deeper observations, and same-path rechecks |
| Full domain playbooks (marketing sites, data consoles, mobile flows, redesigns, font subsetting) |                    —                     |                                  ✓                                  |

### Pro Discovery & Effective Load Diagnostics

Each status query rediscovers local `oil-ui-pro` installations. Explicit configuration and DSH project/user Skill roots (including `~/.dsh/skills` and `~/.agents/skills`) take precedence, followed by oil-cli's user installation targets: `~/.claude/skills`, `$CODEX_HOME/skills` (or `~/.codex/skills` when unset), `~/.cursor/skills`, and `~/.workbuddy/skills`. Only the `oil-ui-pro` child is checked; other directories are not recursively scanned, and these cross-host fallbacks do not affect image-gen discovery. Use `proSkillDir` or `OIL_UI_PRO_DIR` for custom locations. This list follows [oil-cli's installationRoots/targetRoot](https://github.com/oil-oil/oil-cli/blob/e6ee580c01e854919ee50ef1f3de6876c3c52c18/src/skills.js#L139): default installation favors an existing Claude directory, while Codex and DSH normally share `.agents/skills`.

**Both Lite and Pro work unchanged; Pro has one publisher: Harness filesystem.** The plugin publishes bundled `oil-ui` only. It never registers `oil-ui-pro` in Host, preset, or Agent scope, reads private adapter rules, rewrites Pro, or creates Pro caches. Pro's host section in `references/tools.md` explains `oil_ui_shoot`, `oil_ui_media`, `oil_ui_image`, and `oil_ui_explorer`: map flags to matching tool fields and use host status for versions and image sources. These host notes ship with Pro `0.33.1`.

Status checks the definition selected in the calling Agent's scope against the original in its own resource directory, entry path, version, and model invocation permission. Filesystem Lite may differ from bundled Lite and still be ready. Correct original instructions report `skillReady=true`, `nativeSkillReady=true`, `visibleMatchesOriginal=true`, and `skillLoadState=ready`. Mismatches report `overridden`; missing or non-invocable definitions report `unavailable`. `nativeSkillReady` is a compatibility alias, not evidence of transformation. `/oil-ui-status` and `upgradeHint` report the same result; the old `proAdapterReady` field is removed.

Cross-host discovery and `proSkillDir` provide local diagnostics, not publication. If Pro exists only in a Claude directory, install it into a Harness-visible root such as `~/.agents/skills` or `~/.dsh/skills`. See the [single-publisher decision](docs/pro-single-publisher.md).

### Version Check & One-Time Pro Notice

The update check and one-time Pro prompt from upstream `oil-ui` are built directly into `oil_ui_skill_status`:

- **Cached version check & self-update**: `oil_ui_skill_status` normally checks `https://ui.oiloil.org/api/store/versions` at most once every 10 minutes, caching the result in `~/.local/state/oil/<name>-update.json`. Requests time out after 8 seconds and failures back off; an explicit update or a local version newer than the cache triggers an earlier check. When a newer version is available, it attaches `updateNotice`; passing `{"update": true}` (or running `/oil-ui-status update`) updates filesystem Lite/Pro through pinned oil-cli. Bundled Lite only prompts for a plugin update; files inside the plugin installation are never updated in place.
- **One-time Pro prompt**: When running on the free `oil-ui` edition, the first `oil_ui_skill_status` call writes a marker to `~/.local/state/oil-ui/recommended-oil-ui-pro` and returns `recommendOnceNotice` once so the agent can mention [ui.oiloil.org/en/pro](https://ui.oiloil.org/en/pro/) at the end of its reply—never nagging on subsequent runs.

---

## Installation

The package declares support for DeepSeek Harness `>=0.2.1-rc.2 <0.3.0-0` (CI verified on `0.2.1-rc.2`, `0.2.1-rc.3`, `0.2.1-rc.4`, `0.2.1-rc.5`, and `0.2.2-rc.1`) and requires Node.js 22.19.0 or later.

- **DSH Desktop (official desktop app)**: Install directly from **Settings → Plugins → Add Plugin** inside the app using `github:oil-oil/dsh-oil-ui` (or `git+https://atomgit.com/oil-oil/dsh-oil-ui.git` in China). Desktop uses its own isolated `DSH_HOME` directory; do not run `--profile desktop` in the terminal.
- **Upgrading from an older version (`v0.3.1` – `v0.4.8`) or fixing `incompatible with DSH 0.2.2-rc.1 (uninstall and reinstall)`**: Earlier versions pinned an exact `engines.dsh` version in the installed package manifest, and re-adding a Git plugin in-place reports `already-installed` without replacing the locked revision. **Uninstall the old version first, then install again**:
  - Desktop / Web UI: In **Settings → Plugins → Installed**, remove `dsh-oil-ui`, then click **Add Plugin** and enter `github:oil-oil/dsh-oil-ui` (or `git+https://atomgit.com/oil-oil/dsh-oil-ui.git`).
  - CLI (`dsh web`): Run `dsh plugin --profile web remove dsh-oil-ui` first, then run the install command below.

### 1. One-line install into DeepSeek Harness

For the DeepSeek Harness Web UI with the `web` profile, run:

```bash
dsh plugin --profile web add github:oil-oil/dsh-oil-ui
```

In China, you can also install directly from the AtomGit mirror:

```bash
dsh plugin --profile web add git+https://atomgit.com/oil-oil/dsh-oil-ui.git
```

For headless CLI runs, replace `--profile web` with `--profile headless`. For reproducible installation, pin the full commit, for example `github:oil-oil/dsh-oil-ui#362053dcfb169eb133abbb6ade1a1ca198439fe2`. Replace it with the Release commit you actually need instead of relying on a moving branch name.

Because prebuilt `lib/index.js` and the bundled `oil-ui` Skill are committed directly to the repository, no build allowance is required—just launch `dsh web` after installing.

<details>
<summary>Build and install from a local checkout</summary>

```bash
git clone https://github.com/oil-oil/dsh-oil-ui.git
cd dsh-oil-ui
pnpm install --frozen-lockfile
pnpm pack:plugin .work/dsh-oil-ui.tgz
dsh plugin --profile web add ./.work/dsh-oil-ui.tgz
```

</details>

### 2. Optional configuration & runtime dependencies

The plugin works out of the box and automatically discovers local `oil-ui-pro` and `image-gen` installations. To override paths or ports, add an entry override to `~/.dsh/cordis.patch.yml` (global) or `~/.dsh/profiles/web/cordis.patch.yml` (per-profile), matching [`src/config.ts`](src/config.ts):

```yaml
- id: dsh-oil-ui
  name: dsh-oil-ui
  config:
    # Prefer local Pro for discovery/workbench resources (default: true); does not disable filesystem publication
    bundledSkill: true # false keeps tools but leaves Skill publication to filesystem
    preferPro: true
    # Optional: Pro reference source (default: DSH roots, then verified oil-cli installation paths)
    # proSkillDir: /Users/you/.agents/skills/oil-ui-pro
    # Optional: custom path to image_gen.py (auto-discovered in ~/.dsh/skills/image-gen and ~/.agents/skills/image-gen)
    # imageGenScript: /Users/you/.agents/skills/image-gen/scripts/image_gen.py
    # Optional: override workspace root and local preview server port (0 = random available port)
    # workspaceRoot: /path/to/workspace
    # previewPort: 0
```

- **Browser captures (`oil_ui_shoot`)**: Uses locally installed Chrome / Chromium (or Playwright Chromium). Motion frame strips (`record` / `motion`) require `ffmpeg`.
- **AI image generation (`oil_ui_image`)**: Uses local `image-gen` first; when unavailable, it reads the oil CLI token from `OIL_TOKEN` or `~/.config/oil/config.json` and calls oiloil. Set `OIL_API` to override the API root; the default is `https://api.oiloil.org`.

---

## Syncing from Upstream `oil-ui`

When upstream `oil-ui` updates its `SKILL.md`, reference manuals, or scripts:

```bash
OIL_UI_SOURCE_DIR=../oil-ui pnpm sync:skill
pnpm check
pnpm pack:plugin .work/dsh-oil-ui.tgz
```

See [development](docs/development.md), [versioning](docs/versioning.md), and [release](docs/releasing.md) for the maintenance workflow.

---

## License

Released under the [MIT License](LICENSE).
