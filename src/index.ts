import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type FileBlock, type ImageBlock } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-skill';
import '@deepseek-ai/dsh-system-prompt';
import {
  loadUpstreamSkill,
  skillStatus,
  resolveActiveSkill,
  createSkillProvider,
  loadReviewerManual,
  discoverSkill,
  bundledSkillDirectory,
} from './skill/upstream.ts';
import { Config } from './config.ts';
import { DesignWorkbench } from './workbench/index.ts';
import { registerTools } from './tools/index.ts';
export { Config };
export const name = 'dsh-oil-ui';

export const MAIN_AGENT_SYSTEM_PROMPT =
  'For UI tasks, call oil_ui_skill_status first to refresh discovery and read activeSkillName (local oil-ui-pro installs unlock without restarting), then load that Skill using the skill tool. Read and write project files directly in the current working directory. Use oil_ui_explorer for style-explorer.html comparison pages, oil_ui_shoot for screenshots/interactions/responsive checks/recordings, oil_ui_media for public-domain and museum media search/preview/fetch, and oil_ui_image for generating or editing visual assets. Use subagent for independent visual and lightweight UX walkthroughs, with deeper Pro risk probes and same-path rechecks when active.';

export function buildSubagentSystemPrompt(reviewerManual: string, referencesPath?: string): string {
  return [
    '当主 Agent 委派你执行界面视觉或交互评审（UI/UX Review）时，请直接按下方已内置的《视觉与交互评审手册》（`references/reviewer-manual.md`）执行，无需调用 `read_file`、`skill` 或 `oil_ui_skill_status` 重复读取该手册，评审过程中只提供客观评审意见、不修改项目文件。查看图片请用 `read_image`；需要补充 480px/180px 缩略图、遮字图（`mask: true`）或实际操作验证时请用 `oil_ui_shoot`。（若主 Agent 委派的是非评审类的常规子任务，则直接按主 Agent 的任务指令执行。）',
    ...(referencesPath
      ? [
          `当前生效 Skill 的 references/ 绝对路径：${referencesPath}。轻量 UX 走查按需读取 ${referencesPath}/ux-reviewer.md；Pro 另读 ${referencesPath}/review-modes.md 与 ${referencesPath}/play-craft.md。`,
        ]
      : []),
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

export function apply(ctx: Context, config: Config) {
  const workbench = new DesignWorkbench(config.workspaceRoot, config.previewPort, config);
  ctx.effect(() => () => workbench.dispose());
  let invalidateSkills: (() => void) | undefined;
  let provider: ReturnType<typeof createSkillProvider> | undefined;
  let skillsRegistry: Context['skills'] | undefined;
  const reportStatus = async (skillsCtx: Context, scope: Agent | undefined, update: boolean) => {
    const cwd = scope?.session.header.cwd;
    const discovered = provider
      ? await provider.refresh(cwd)
      : { snapshot: await discoverSkill({ ...config, cwd }), changed: false };
    if (discovered.changed) invalidateSkills?.();
    const visible = await skillsCtx.skills.get(discovered.snapshot.active.name, { scope, cwd });
    const status = await skillStatus(visible, { ...config, cwd, update }, discovered.snapshot);
    if (update) invalidateSkills?.();
    return status;
  };

  registerTools(ctx, {
    config,
    workbench,
    reportStatus,
    onSkills: (registry) => {
      skillsRegistry ??= registry;
    },
  });

  ctx.inject(['skills'], async (ctx) => {
    skillsRegistry = ctx.skills;
    if (typeof ctx.skills.registerProvider === 'function') {
      ctx.skills.registerProvider((control) => {
        invalidateSkills = () => control.invalidate?.();
        return (provider = createSkillProvider(config, control));
      });
    } else {
      ctx.skills.register(await loadUpstreamSkill(config));
    }
  });

  ctx.inject(['commands', 'skills'], (ctx) => {
    skillsRegistry ??= ctx.skills;
    if (!ctx.commands || typeof ctx.commands.register !== 'function') return;
    ctx.effect(() => {
      const disposeStatus = ctx.commands.register({
        name: 'oil-ui-status',
        description: '查看当前生效版本、更新状态、生图来源与 oiloil 余额（传入 update 可直接更新）',
        input: {
          hint: '[update]',
        },
        handler: async (invocation) => {
          const arg = invocation.rawInput.trim().toLowerCase();
          if (arg.length > 0 && arg !== 'update') {
            return {
              kind: 'error',
              text: '用法：/oil-ui-status [update]',
            };
          }
          const status = await reportStatus(ctx, invocation.agent, arg === 'update');
          const lines = [
            `当前生效 Skill：${status.activeSkillName}（${status.edition === 'pro' ? 'Pro' : 'Lite'}）v${status.activeVersion}`,
            ...(status.visibleMatchesOriginal === false && status.detected
              ? [
                  `注意：检测到本地 ${status.detected.name}（${status.detected.path}），但当前作用域被 ${status.effective?.provider ?? '外部同名 Skill'} 覆盖`,
                ]
              : []),
            `最新版本：${status.latestVersion ?? status.activeVersion}${status.updateAvailable ? '（有新版本可用，可运行 /oil-ui-status update 更新）' : ''}`,
            `本地 Pro：${status.proInstalled ? `已检测到（${status.proSourcePath}）` : '未安装'}`,
            `本地生图（image-gen）：${status.imageGenAvailable ? `可用（${status.imageGenScriptPath}）` : '未检测到'}`,
            `生图来源：${status.imageSource === 'image-gen' ? 'image-gen' : status.imageSource === 'oiloil' ? 'oiloil' : '无'}`,
            ...(status.oilLoggedIn
              ? [`oiloil 余额：${status.oilBalance === null ? '暂时无法查询' : `${status.oilBalance} 积分`}`]
              : []),
            ...(status.updateCheckError ? [`版本检查异常：${status.updateCheckError}`] : []),
            ...(status.transformWarning ? [`转换提示：${status.transformWarning}`] : []),
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
        handler: (invocation) => {
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
        handler: (invocation) => {
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
        const effective = await skillsRegistry?.get(snapshot.active.name, { scope: agent, cwd: options.cwd });
        active =
          effective?.resourceBase?.kind === 'directory' &&
          effective.provider &&
          effective.provider !== 'oil-ui-provider'
            ? { ...snapshot.active, directory: effective.resourceBase.path }
            : await resolveActiveSkill(options, snapshot);
        referencesPath = join(active.directory, 'references');
      } catch {
        /* Discovery failure still allows the bundled review manual. */
        active = {
          edition: 'lite' as const,
          name: 'oil-ui' as const,
          directory: bundledSkillDirectory,
          source: 'bundled-lite' as const,
        };
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
        const cleanup = () => {
          if (reviewerDisposers.delete(cleanup)) dispose();
        };
        reviewerDisposers.add(cleanup);
        agent.ctx.effect?.(() => cleanup);
      }
    } catch {
      installed.delete(agent);
      /* Reviewer setup must never interrupt agent/created. */
    }
  };

  ctx.inject(['systemPrompt'], (ctx) => {
    ctx.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: 'oil-ui',
        order: 70,
        interpolate: false,
        text: MAIN_AGENT_SYSTEM_PROMPT,
      });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
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
