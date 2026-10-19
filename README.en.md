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
- **Compiled automatically from upstream `oil-ui`**: Upstream `SKILL.md` and `references/*.md` files are automatically transformed so CLI script invocations map cleanly to native `dsh-oil-ui` tool calls. When upstream `oil-ui` changes, a single `pnpm vendor:skill` updates the plugin.

---

## How It Runs in DeepSeek Harness

From a short prompt, the agent runs the full loop—**explore directions → bundle comparison page → build interactive interface → verify on real screenshots**:

<p align="center">
  <img src="assets/readme/proof-archon.webp" alt="ARCHON 3-direction comparison page in DeepSeek Harness" width="100%">
</p>

<p align="center">
  <img src="assets/readme/proof-tempo.webp" alt="Tempo 2026 3-direction mobile comparison page in DeepSeek Harness" width="100%">
</p>

1. Calls `oil_ui_skill_status` to check available Skills (automatically selecting `oil-ui-pro` when installed), then loads the active Skill and reference manuals via the native `skill` tool.
2. Builds 3 distinct first-screen candidates in `explore/` and bundles them into a self-contained `style-explorer.html` via `oil_ui_explorer`.
3. Implements the chosen direction in `index.html` (and `screens.html` for multi-screen mobile flows), verifies states, interactions, and responsive viewports with `oil_ui_shoot`, and inspects every capture with `read_image`.

---

## Native Tools & Slash Commands

The plugin registers 5 tools, all resolved relative to the active session's working directory (`cwd`):

| Tool | What it does |
| --- | --- |
| `oil_ui_skill_status` | Refreshes local Skill discovery, returns `activeSkillName` (`oil-ui` or `oil-ui-pro`), checks for Skill updates, and handles the one-time Pro recommendation notice |
| `oil_ui_explorer` | Reads `explore/manifest.json` (normalizing common shorthand fields) and bundles candidate HTML files into a single interactive `style-explorer.html` comparison page |
| `oil_ui_shoot` | Captures real browser screenshots of local files or URLs: supports custom viewports, 2x zoom crops, multi-state captures (`states`), scripted interactions (`steps`), motion recordings (`record` / `motion`), contact sheets (`evidence`), and built-in console/overflow/contrast checks |
| `oil_ui_media` | Searches, previews, and downloads public-domain images, museum collections (Met, AIC, Cleveland, Wikimedia, Openverse), video clips, and map tiles |
| `oil_ui_image` | Generates or edits hero visuals, illustrations, textures, and cutout assets via the locally installed `image-gen` Skill |

It also registers 3 `oil-ui-` slash commands in the composer (namespaced to avoid collisions with other `oil-*` Skills):

| Command | What it does |
| --- | --- |
| `/oil-ui-status [update]` | Inspects the active Oil UI edition (`oil-ui` / `oil-ui-pro`), version update status, and `image-gen` availability; pass `update` to update in place |
| `/oil-ui-explore <brief>` | Accepts optional reference attachments and queues a 3-direction exploration (`style-explorer.html`) |
| `/oil-ui-review [target]` | Accepts optional screenshot/file attachments and queues a two-track UI/UX review (visual hierarchy + task flow) |

---

## Oil UI Pro & Update Checks

`dsh-oil-ui` bundles the free `oil-ui` Skill out of the box. For production landing pages, dense product consoles, and multi-round visual polish, you can pair it with **[Oil UI Pro](https://ui.oiloil.org/en/pro/)**.

### What Oil UI Pro Adds

| Capability | `oil-ui` (Bundled Free) | `Oil UI Pro` |
| --- | :---: | :---: |
| 3-direction exploration + `style-explorer.html` comparison page | ✓ | ✓ |
| Screenshot-driven multi-round visual refinement & typography/contrast linting | — | ✓ |
| Multi-state captures (`states`), scripted interactions (`steps`) & motion frame strips | — | ✓ |
| Museum/public-domain media (`oil_ui_media`) & AI image generation (`oil_ui_image`) playbooks | — | ✓ |
| Independent visual review subagent (`subagent` auto-injected with `reviewer-manual.md`) | — | ✓ |
| Full domain playbooks (marketing sites, data consoles, mobile flows, redesigns, font subsetting) | — | ✓ |

### Automatic Local Pro Detection & Subagent Review Injection

Once `oil-ui-pro` is installed locally (in `~/.agents/skills/oil-ui-pro` or `~/.dsh/skills/oil-ui-pro`), you do not need to restart DeepSeek Harness. When the agent calls `oil_ui_skill_status`, the plugin scans your local Skill directories, compiles `oil-ui-pro` and its reference manuals into native tool instructions, and registers them above the built-in filesystem loader. When the main agent spawns a `subagent` for visual and interaction review, the plugin automatically injects the compiled `reviewer-manual.md` and `references/` directory path into the subagent's system prompt.

### Version Check & One-Time Pro Notice

The update check and one-time Pro prompt from upstream `oil-ui` are built directly into `oil_ui_skill_status`:

- **Cached version check & self-update**: `oil_ui_skill_status` checks `https://ui.oiloil.org/api/store/versions` at most once per day (cached in `~/.local/state/oil/<name>-update.json`, with automatic backoff when offline so it never blocks a task). When a newer version is available, it attaches `updateNotice`; passing `{"update": true}` (or running `/oil-ui-status update`) updates the active Skill in place.
- **One-time Pro prompt**: When running on the free `oil-ui` edition, the first `oil_ui_skill_status` call writes a marker to `~/.local/state/oil-ui/recommended-oil-ui-pro` and returns `recommendOnceNotice` once so the agent can mention [ui.oiloil.org/en/pro](https://ui.oiloil.org/en/pro/) at the end of its reply—never nagging on subsequent runs.

---

## Installation

### 1. One-line install into DeepSeek Harness

For the default DeepSeek Harness Web UI (`dsh web`), run:

```bash
dsh plugin --profile web add github:oil-oil/dsh-oil-ui
```

(For headless CLI runs, replace `--profile web` with `--profile headless`.)

Because prebuilt `lib/index.js` and the bundled `oil-ui` Skill are committed directly to the repository, no build allowance is required—just launch `dsh web` after installing.

<details>
<summary>Build and install from a local checkout</summary>

```bash
git clone https://github.com/oil-oil/dsh-oil-ui.git
cd dsh-oil-ui
pnpm install
pnpm pack:plugin
dsh plugin --profile web add ./.work/dsh-oil-ui-0.3.2.tgz
```

</details>

### 2. Optional configuration & runtime dependencies

The plugin works out of the box and automatically discovers local `oil-ui-pro` and `image-gen` installations. To override paths or ports, add an entry override to `~/.dsh/cordis.patch.yml` (global) or `~/.dsh/profiles/web/cordis.patch.yml` (per-profile), matching [`src/config.ts`](src/config.ts):

```yaml
- id: dsh-oil-ui
  name: dsh-oil-ui
  config:
    # Prefer locally installed oil-ui-pro when available (default: true)
    preferPro: true
    # Optional: custom path to oil-ui-pro (auto-discovered in .dsh/skills and .agents/skills)
    # proSkillDir: /Users/you/.agents/skills/oil-ui-pro
    # Optional: custom path to image_gen.py (auto-discovered in ~/.dsh/skills/image-gen and ~/.agents/skills/image-gen)
    # imageGenScript: /Users/you/.agents/skills/image-gen/scripts/image_gen.py
    # Optional: override workspace root and local preview server port (0 = random available port)
    # workspaceRoot: /path/to/workspace
    # previewPort: 0
```

- **Browser captures (`oil_ui_shoot`)**: Uses locally installed Chrome / Chromium (or Playwright Chromium). Motion frame strips (`record` / `motion`) require `ffmpeg`.
- **AI image generation (`oil_ui_image`)**: Delegates to your local `image-gen` Skill (`python3`), using `image-gen`'s own environment variables for model and API key configuration.

---

## Syncing from Upstream `oil-ui`

When upstream `oil-ui` updates its `SKILL.md`, reference manuals, or scripts:

```bash
pnpm vendor:skill   # Syncs from ../oil-ui (or OIL_UI_SOURCE_DIR)
pnpm test           # Runs plugin and Skill transformation tests
pnpm pack:plugin    # Rebuilds and packs .work/dsh-oil-ui-<version>.tgz
```

---

## License

Released under the [MIT License](LICENSE).
