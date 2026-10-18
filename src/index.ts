import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type FileBlock, type ImageBlock } from '@deepseek-ai/dsh-llm';
import { defineTool, type ToolRunContext, type InferValue } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-skill';
import '@deepseek-ai/dsh-system-prompt';
import { loadUpstreamSkill, skillStatus, resolveActiveSkill, createSkillProvider, loadReviewerManual, discoverSkill, bundledSkillDirectory } from './upstream.ts';
import { Config } from './config.ts';
import { DesignWorkbench } from './workbench.ts';
export { Config };
export const name = 'dsh-oil-ui';

export const MAIN_AGENT_SYSTEM_PROMPT =
  'For UI tasks, call oil_ui_skill_status first to refresh discovery and read activeSkillName (local oil-ui-pro installs unlock without restarting), then load that Skill using the skill tool. Read and write project files directly in the current working directory. Use oil_ui_explorer for style-explorer.html comparison pages, oil_ui_shoot for screenshots/interactions/responsive checks/recordings, oil_ui_media for public-domain and museum media search/preview/fetch, and oil_ui_image for generating or editing visual assets.';

export function buildSubagentSystemPrompt(reviewerManual: string, referencesPath?: string): string {
  return [
    '当主 Agent 委派你执行界面视觉或交互评审（UI/UX Review）时，请直接按下方已内置的《视觉与交互评审手册》（`references/reviewer-manual.md`）执行，无需调用 `read_file`、`skill` 或 `oil_ui_skill_status` 重复读取该手册，评审过程中只提供客观评审意见、不修改项目文件。查看截图请用 `read_image`；需要补充 480px/180px 缩略图、遮字图（`mask: true`）或实际操作验证时请用 `oil_ui_shoot`。（若主 Agent 委派的是非评审类的常规子任务，则直接按主 Agent 的任务指令执行。）',
    ...(referencesPath ? [`当前生效 Skill 的 references/ 绝对路径：${referencesPath}。Pro 评审按需读取 ${referencesPath}/review-modes.md 与 ${referencesPath}/play-craft.md。`] : []),
    '',
    reviewerManual.trim(),
  ].join('\n');
}

interface OilUiCommandInvocation {
  readonly agent: Agent;
  readonly rawInput: string;
  readonly attachments: readonly (ImageBlock | FileBlock)[];
  readonly signal: AbortSignal;
}

interface OilUiCommandResult {
  readonly kind: 'success' | 'error';
  readonly text?: string;
}

interface OilUiCommandRuntime {
  register(definition: {
    readonly name: string;
    readonly description: string;
    readonly input?: {
      readonly hint: string;
      readonly attachments?: boolean;
    };
    readonly handler: (invocation: OilUiCommandInvocation) => OilUiCommandResult | Promise<OilUiCommandResult>;
  }): () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    commands: OilUiCommandRuntime;
  }
}

function sessionCwd(exec: ToolRunContext, fallback?: string): string {
  if (!exec.agent) throw new Error('Oil UI requires a session-owned agent execution');
  const cwd = exec.agent.session.header.cwd?.trim() || fallback?.trim();
  if (!cwd) throw new Error('Oil UI requires a session working directory');
  return cwd;
}

type JsonValue = InferValue<{ type: 'json' }>;
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
const stringOrStrings = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } as const;
const boolOrString = { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false', '0', '1'] }] } as const;
const viewportSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: false, properties: {
      width: { type: 'integer', required: true, description: '视口宽度。' },
      height: { type: 'integer', required: true, description: '视口高度。' },
    } },
  ],
} as const;
const manifestSchema = {
  oneOf: [
    { type: 'string' },
    { type: 'object', additionalProperties: false, properties: {
      schemaVersion: { type: 'integer', const: 1, required: true, description: '清单版本，固定为 1。' },
      project: { type: 'string', required: true, description: '项目名称。' },
      brief: { type: 'string', required: true, description: '设计需求。' },
      candidates: { type: 'array', required: true, description: '候选方向数组。', items: {
        type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true, description: '唯一方向编号。' },
          name: { type: 'string', required: true, description: '方向名称。' },
          concept: { type: 'string', required: true, description: '设计概念。' },
          typography: { type: 'string', required: true, description: '字体方案。' },
          traits: { type: 'array', items: { type: 'string' }, required: true, description: '方向特征。' },
          palette: { type: 'array', items: { type: 'string' }, required: true, description: '十六进制配色。' },
          kind: { type: 'string', enum: ['html', 'image', 'url'], description: '候选内容类型。' },
          source: { type: 'string', description: '本地候选路径或本地服务 URL。' },
          url: { type: 'string', description: '本地服务 URL，作为 source 的别名。' },
          baseline: { type: 'boolean', description: '是否为基准方向。' },
          interactive: { type: 'boolean', description: '是否允许 HTML 候选交互。' },
          nativeViewport: { ...viewportSchema, description: '候选原始视口。' },
        },
      } },
      round: { type: 'string', description: '探索轮次。' },
      lang: { type: 'string', enum: ['zh', 'en'], description: '界面语言。' },
      nativeViewport: { ...viewportSchema, description: '共享原始视口。' },
      serve: { type: 'object', additionalProperties: false, description: '本地服务信息。', properties: {
        command: { type: 'string', required: true, description: '启动命令。' },
        cwd: { type: 'string', description: '绝对工作目录。' },
        url: { type: 'string', description: '本地服务地址。' },
      } },
    } },
  ],
} as const;
const nativeOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function apply(ctx: Context, config: Config) {
  const workbench = new DesignWorkbench(config.workspaceRoot, config.previewPort, config);
  ctx.effect(() => () => workbench.dispose());
  let invalidateSkills: (() => void) | undefined;
  let provider: ReturnType<typeof createSkillProvider> | undefined;
  const reportStatus = async (scope: Agent | undefined, update: boolean) => {
    const cwd = scope?.session.header.cwd;
    const discovered = provider ? await provider.refresh(cwd) : { snapshot: await discoverSkill({ ...config, cwd }), changed: false };
    if (discovered.changed) invalidateSkills?.();
    const visible = await ctx.skills.get(discovered.snapshot.active.name, { scope, cwd });
    const status = await skillStatus(visible, { ...config, cwd, update }, discovered.snapshot);
    if (update) invalidateSkills?.();
    return status;
  };

  ctx.inject(['tools', 'skills'], ctx => {
    ctx.tools.register(
      defineTool({
        name: 'oil_ui_skill_status',
        isConcurrencySafe: args => !Boolean(args && typeof args === 'object' && (args as { update?: unknown }).update),
        description:
          'Report the active oil-ui edition, local Pro installation, versions, update check status, one-time Pro recommendation, local image-gen availability and scoped Skill registration. Pass update=true only when the user explicitly confirms updating.',
        parameters: {
          update: { type: 'boolean', description: '仅在用户明确要求时检查并更新 Skill。' },
        },
        output: nativeOutput,
        execute: async (args, exec) => {
          return json(await reportStatus(exec.agent, Boolean(args?.update)));
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_explorer',
        description:
          'Generate a portable single-file style-explorer.html comparison page in the current working directory from a manifest or explore/a.html, b.html, c.html (or directions/a.html, b.html, c.html). Inlines local assets and stylesheets and returns the preview URL.',
        parameters: {
          manifest: { ...manifestSchema, description: '对比页清单 JSON 对象、JSON 字符串或工作区内的清单文件路径（如 explore/manifest.json）。' },
          out: { type: 'string', description: '对比页 HTML 输出路径，默认 style-explorer.html。' },
          title: { type: 'string', description: '对比页标题。' },
          brief: { type: 'string', description: '设计需求摘要。' },
          request: { type: 'string', description: '设计需求，作为 brief 的别名。' },
        },
        output: nativeOutput,
        execute: async (args, exec) => json(await workbench.explorer(sessionCwd(exec, config.workspaceRoot), args)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_shoot',
        timeoutMs: 905_000,
        description:
          'Capture screenshots, interactive state sequences, multi-viewport responsive checks, element crops, motion recordings, pixel comparisons, or stitched sheets using the active Skill screenshot engine in the current working directory. Local HTML files are served over a workspace-rooted HTTP server so relative paths like ../assets/ resolve cleanly.',
        parameters: {
          target: { type: 'string', description: '本地 HTML 文件或 HTTP(S) 地址，支持查询串和锚点。' },
          out: { type: 'string', description: '工作区内输出 PNG 文件或目录路径；多状态连拍、多尺寸、证据集与录屏须传目录。' },
          mode: { type: 'string', enum: ['shot', 'compare', 'evidence'], description: '执行模式：shot（单图/多图）、compare（像素比对）、evidence（交付证据集）。' },
          before: { type: 'string', description: '比较前的本地图像路径，作为 compare 的别名。' },
          after: { type: 'string', description: '比较后的本地图像路径；传入后生成并排对比。' },
          compare: { type: 'string', description: '用于像素比较的本地参考图路径。' },
          size: { type: 'string', description: '视口尺寸或预设，默认 1440x900；支持 desktop、mobile、1440x900，可逗号分隔多个尺寸。' },
          viewport: { type: 'string', description: '截图视口尺寸，作为 size 的别名。' },
          states: { ...stringOrStrings, description: '状态名称数组或逗号分隔字符串，通过地址参数打开。' },
          param: { type: 'string', description: '状态地址参数名，默认 state。' },
          query: { type: 'string', description: '附加到页面地址的额外查询参数（如 theme=dark&lang=zh）。' },
          zoom: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } }], description: '截图像素倍数，可传数值、逗号分隔字符串或倍数数组。' },
          fullPage: { type: 'boolean', description: '是否截取整个页面。' },
          mask: { type: 'boolean', description: '是否生成遮字图。' },
          sheet: { type: 'boolean', description: '是否生成联系表。' },
          mark: { type: 'string', description: '截图标注规则，如 1=.open。' },
          selector: { type: 'string', description: '等待并标注的单个 CSS 选择器。' },
          steps: { ...stringOrStrings, description: '交互动作字符串或动作组数组，组内用分号分隔。' },
          record: { ...boolOrString, description: '是否录屏，兼容字符串 true/false。' },
          entry: { type: 'boolean', description: '是否在打开页面前开始录屏。' },
          holdMs: { type: 'integer', description: '交互后的停留时长，单位毫秒，范围 0–120000。' },
          motion: { ...boolOrString, description: '是否探测动效，兼容字符串 true/false。' },
          evidence: { type: 'boolean', description: '是否生成状态、截图和录屏证据集。' },
          stitch: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true, description: '本地图像路径。' }, label: { type: 'string', description: '图像标签。' } } }] }, description: '拼图输入，每项是本地图像路径或含 path、label 的对象。' },
          columns: { type: 'integer', description: '拼图或录屏帧序列的列数。' },
          frames: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: '录屏帧序列的帧数，范围 2–120。' },
          waitMs: { type: 'integer', description: '截图前等待时长，单位毫秒，范围 0–120000。' },
          timeoutScale: { type: 'number', description: '截图引擎内部超时倍数。' },
          dryRun: { type: 'boolean', description: '仅验证截图参数，不启动截图。' },
          timeoutMs: { type: 'integer', description: '工具总超时时长，单位毫秒，最大 900000。' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.shoot(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_media',
        timeoutMs: 905_000,
        isConcurrencySafe: args =>
          Boolean(
            args &&
              typeof args === 'object' &&
              (args as { action?: unknown }).action === 'search' &&
              !(args as { out?: unknown }).out,
          ),
        description:
          'Search museum, open-access, photo, video and 3D/PBR asset providers, preview candidates on a numbered contact sheet, and download selected assets into the current working directory using the active Skill media engine. Inspect each item license and attribution.',
        parameters: {
          action: { type: 'string', enum: ['search', 'preview', 'fetch', 'search_and_fetch'], description: '素材操作，默认搜索并下载；传 refs 时默认下载。' },
          query: { type: 'string', description: '搜索关键词；支持用 | 分隔多个备选词（如 "oak planks | belgian oak"）。' },
          refs: { ...stringOrStrings, description: '缓存候选编号（如 C1、T2）或直接下载的素材 URL，支持逗号分隔字符串或数组。' },
          dir: { type: 'string', description: '素材输出目录，默认 assets/media。' },
          out: { type: 'string', description: '单文件 URL 下载时的输出路径（如 assets/photo.jpg），不可覆盖已有文件。' },
          kind: { type: 'string', enum: ['all', 'texture', 'design', 'photo', 'blueprint', 'map', 'plate', 'science', 'video'], description: '素材类别。' },
          use: { type: 'string', enum: ['page', 'reference', 'all'], description: '素材用途：页面使用、仅供参考或全部。' },
          limit: { type: 'integer', description: '最多返回的候选数，范围 1–30。' },
          sources: { ...stringOrStrings, description: '按来源筛选，支持来源名称数组或逗号分隔字符串。' },
          sheet: { type: 'boolean', description: '是否生成候选或已下载素材的联系表 PNG。' },
          maps: { ...stringOrStrings, description: '贴图通道，支持 diffuse、roughness、normal、all 或通道数组。' },
          resolution: { type: 'string', description: '贴图分辨率，如 1k。' },
          videoSize: { type: 'string', description: '视频版本，如 medium、small、preview、orig。' },
          note: { type: 'string', description: '下载素材的来源或用途说明。' },
          refresh: { type: 'boolean', description: '是否忽略搜索缓存重新搜索。' },
          timeoutMs: { type: 'integer', description: '工具总超时时长，单位毫秒，最大 900000。' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.media(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_image',
        timeoutMs: 905_000,
        description:
          'Generate images or edit 1–16 local reference images in the current working directory using the locally installed image-gen Skill and python3. Defaults to edit when images are provided. Use background=transparent for cutout assets; the local service credentials and model apply.',
        parameters: {
          prompt: { type: 'string', required: true, description: '生成或编辑图片的提示词描述。' },
          mode: { type: 'string', enum: ['generate', 'edit'], description: '生图模式：generate（文生图）或 edit（基于参考图改图/派生变体，传入 images 时默认 edit）。' },
          out: { type: 'string', description: '生成或编辑后的图片输出路径，默认 assets/generated.png。' },
          images: { type: 'array', items: { type: 'string' }, description: '工作区内的参考图路径数组，编辑支持 1–16 张。' },
          size: { type: 'string', description: '生成图片尺寸，如 1024x1024、1536x1024、1024x1536 或 auto。' },
          quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'], description: '图片生成质量。' },
          background: { type: 'string', enum: ['auto', 'opaque', 'transparent'], description: '图片背景类型；透明底抠图素材选 transparent。' },
          model: { type: 'string', description: '可选的图片模型标识。' },
          force: { type: 'boolean', description: '是否允许覆盖已有输出文件，默认 false（默认路径重名时自动递增文件名避让）。' },
          timeoutMs: { type: 'integer', description: '工具总超时时长，单位毫秒，最大 900000。' },
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.image(sessionCwd(exec, config.workspaceRoot), args, exec.signal)),
      }),
    );
  });

  ctx.inject(['skills'], async ctx => {
    if (typeof ctx.skills.registerProvider === 'function') {
      ctx.skills.registerProvider(control => {
        invalidateSkills = () => control.invalidate?.();
        return provider = createSkillProvider(config, control);
      });
    } else {
      ctx.skills.register(await loadUpstreamSkill(config));
    }
  });

  ctx.inject(['commands', 'skills'], ctx => {
    if (!ctx.commands || typeof ctx.commands.register !== 'function') return;
    ctx.effect(() => {
      const disposeStatus = ctx.commands.register({
        name: 'oil-ui-status',
        description: '查看当前生效版本（oil-ui / oil-ui-pro）、更新状态与生图可用性（传入 update 可直接更新）',
        input: {
          hint: '[update]',
        },
        handler: async invocation => {
          const arg = invocation.rawInput.trim().toLowerCase();
          if (arg.length > 0 && arg !== 'update') {
            return {
              kind: 'error',
              text: '用法：/oil-ui-status [update]',
            };
          }
          const status = await reportStatus(invocation.agent, arg === 'update');
          const lines = [
            `当前生效 Skill：${status.activeSkillName}（${status.edition === 'pro' ? 'Pro' : 'Lite'}）v${status.activeVersion}`,
            ...(status.visibleMatchesOriginal === false && status.detected
              ? [`注意：检测到本地 ${status.detected.name}（${status.detected.path}），但当前作用域被 ${status.effective?.provider ?? '外部同名 Skill'} 覆盖`]
              : []),
            `最新版本：${status.latestVersion ?? status.activeVersion}${status.updateAvailable ? '（有新版本可用，可运行 /oil-ui-status update 更新）' : ''}`,
            `本地 Pro：${status.proInstalled ? `已检测到（${status.proSourcePath}）` : '未安装'}`,
            `本地生图（image-gen）：${status.imageGenAvailable ? `可用（${status.imageGenScriptPath}）` : '未检测到'}`,
            ...(status.updateNotice ? [status.updateNotice] : []),
            ...(status.recommendOnceNotice ? [status.recommendOnceNotice] : []),
          ];
          return {
            kind: 'success',
            text: lines.join('\n'),
          };
        },
      });

      const disposeExplore = ctx.commands.register({
        name: 'oil-ui-explore',
        description: '探索 3 个不同设计方向并生成 style-explorer.html 同屏对比页',
        input: {
          hint: '<设计需求或目标页面>',
          attachments: true,
        },
        handler: invocation => {
          const brief = invocation.rawInput.trim();
          if (brief.length === 0 && invocation.attachments.length === 0) {
            return {
              kind: 'error',
              text: '用法：/oil-ui-explore <设计需求或目标页面>',
            };
          }
          const prompt = [
            'Call oil_ui_skill_status first and load the active Oil UI Skill using the skill tool.',
            'Explore 3 genuinely distinct design directions in explore/a.html, explore/b.html, and explore/c.html, package them into style-explorer.html with oil_ui_explorer, and inspect the comparison page and cards with oil_ui_shoot.',
            ...(brief ? ['', `Design brief: ${brief}`] : []),
          ].join('\n');
          invocation.agent.followup(
            createUserMessage({
              content: [...invocation.attachments, { type: 'text', text: prompt }],
              source: { kind: 'user' },
            }),
          );
          return {
            kind: 'success',
            text: '已发起 Oil UI 三方向设计探索。',
          };
        },
      });

      const disposeReview = ctx.commands.register({
        name: 'oil-ui-review',
        description: '截取真实页面画面，执行视觉层级与交互可用性双轨走查',
        input: {
          hint: '[文件、URL 或评审重点]',
          attachments: true,
        },
        handler: invocation => {
          const target = invocation.rawInput.trim();
          const prompt = [
            'Call oil_ui_skill_status first and load the active Oil UI Skill using the skill tool.',
            'Capture desktop and mobile screenshots and key interactive states with oil_ui_shoot, then conduct a two-track UI/UX review covering visual hierarchy/craft and usability/task flow.',
            ...(target ? ['', `Review target: ${target}`] : []),
          ].join('\n');
          invocation.agent.followup(
            createUserMessage({
              content: [...invocation.attachments, { type: 'text', text: prompt }],
              source: { kind: 'user' },
            }),
          );
          return {
            kind: 'success',
            text: '已发起 Oil UI 双轨 UI/UX 走查。',
          };
        },
      });

      return () => {
        disposeStatus?.();
        disposeExplore?.();
        disposeReview?.();
      };
    });
  });

  const installed = new WeakSet<Agent>();
  const reviewerDisposers = new Set<() => void>();
  let disposed = false;
  ctx.effect(() => () => {
    disposed = true;
    for (const dispose of reviewerDisposers) dispose();
    reviewerDisposers.clear();
  });
  const installSubagentPrompt = async (agent: Agent) => {
    if (disposed || installed.has(agent) || agent.session?.header?.origin !== 'subagent') return;
    if (!agent.ctx?.systemPrompt || typeof agent.ctx.systemPrompt.section !== 'function') return;
    installed.add(agent);
    try {
      const options = { ...config, cwd: agent.session.header.cwd };
      let active;
      let referencesPath = join(bundledSkillDirectory, 'references');
      try {
        const snapshot = await discoverSkill(options);
        referencesPath = join(snapshot.active.directory, 'references');
        const effective = await ctx.skills?.get(snapshot.active.name, { scope: agent, cwd: options.cwd });
        active = effective?.resourceBase?.kind === 'directory'
          ? { ...snapshot.active, directory: effective.resourceBase.path } : await resolveActiveSkill(options, snapshot);
        referencesPath = join(active.directory, 'references');
      } catch { /* Discovery failure still allows the bundled review manual. */
        active = { edition: 'lite' as const, name: 'oil-ui' as const, directory: bundledSkillDirectory, source: 'bundled-lite' as const };
      }
      const manual = await loadReviewerManual(options, active);
      if (!manual || disposed) return;
      const dispose = agent.ctx.systemPrompt.section({
        name: 'oil-ui-subagent-reviewer',
        order: 71,
        interpolate: false,
        text: buildSubagentSystemPrompt(manual, referencesPath),
      });
      if (typeof dispose === 'function') {
        const cleanup = () => { if (reviewerDisposers.delete(cleanup)) dispose(); };
        reviewerDisposers.add(cleanup);
        agent.ctx.effect?.(() => cleanup);
      }
    } catch {
      installed.delete(agent);
      /* Reviewer setup must never interrupt agent/created. */
    }
  };

  ctx.inject(['systemPrompt'], ctx => {
    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: 'oil-ui',
        order: 70,
        interpolate: false,
        text: MAIN_AGENT_SYSTEM_PROMPT,
      });
      return () => { if (typeof dispose === 'function') dispose(); };
    });
    for (const agent of ctx.agents?.list?.() ?? []) {
      void installSubagentPrompt(agent);
    }
    ctx.on?.('agent/created', ({ agent }) => {
      void installSubagentPrompt(agent);
      return undefined;
    });
  });
}

