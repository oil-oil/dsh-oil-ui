import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { defineTool, type ToolRunContext, type InferValue, type GenericCallView } from '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-skill';
import type { Config } from '../config.ts';
import type { DesignWorkbench } from '../workbench/index.ts';
import type { skillStatus } from '../skill/upstream.ts';
import { boolOrString, manifestSchema, stringOrStrings } from './schemas.ts';

interface ToolRegistrationOptions {
  config: Config;
  workbench: DesignWorkbench;
  reportStatus(ctx: Context, scope: Agent | undefined, update: boolean): ReturnType<typeof skillStatus>;
  onSkills(registry: Context['skills']): void;
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

const nativeOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function registerTools(ctx: Context, options: ToolRegistrationOptions): void {
  const { config, workbench, reportStatus } = options;
  ctx.inject(['tools', 'skills'], (ctx) => {
    options.onSkills(ctx.skills);
    ctx.tools.register(
      defineTool({
        name: 'oil_ui_skill_status',
        isConcurrencySafe: (args) =>
          !Boolean(args && typeof args === 'object' && (args as { update?: unknown }).update),
        description:
          '查看当前生效的 Oil UI 版本、更新状态、生图来源（image-gen / oiloil / 无）、oiloil 登录余额与子 Agent 评审手册注入状态。仅在用户明确要求更新时传入 update=true。',
        parameters: {
          update: { type: 'boolean', description: '仅在用户明确要求时检查并更新 Skill。' },
        },
        presentCall: (args): GenericCallView => ({
          card: 'generic',
          title: args.update ? '更新 Oil UI Skill' : '查看 Oil UI Skill 状态',
          kind: 'read',
        }),
        output: nativeOutput,
        execute: async (args, exec) => {
          return json(await reportStatus(ctx, exec.agent, Boolean(args?.update)));
        },
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_explorer',
        description:
          '从 manifest.json、候选目录或多个 HTML 文件生成内嵌全部本地资源的独立单文件风格对比页 style-explorer.html，并返回预览地址。',
        parameters: {
          manifest: {
            ...manifestSchema,
            description:
              '可选的对比页清单对象、JSON 字符串或工作区内路径；路径也可指向候选目录或单个 HTML 文件。目录内有 manifest.json 时优先读取。',
          },
          inputs: {
            ...stringOrStrings,
            description:
              '可选的候选目录或 HTML 文件路径数组；多个输入必须全部是 HTML。目录内有 manifest.json 时优先读取。',
          },
          out: { type: 'string', description: '对比页 HTML 输出路径，默认 style-explorer.html。' },
          title: { type: 'string', description: '对比页标题。' },
          brief: { type: 'string', description: '设计需求摘要。' },
          request: { type: 'string', description: '设计需求，作为 brief 的别名。' },
        },
        // Deliverables collects successful generic edit calls through their output locations.
        presentCall: (args): GenericCallView => ({
          card: 'generic',
          title: '生成风格对比页',
          kind: 'edit',
          locations: [{ path: args.out || 'style-explorer.html' }],
        }),
        output: nativeOutput,
        execute: async (args, exec) => json(await workbench.explorer(sessionCwd(exec, config.workspaceRoot), args)),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_shoot',
        timeoutMs: 905_000,
        description:
          '对本地 HTML、候选目录（如 explore）或页面地址执行截图、半尺寸快速缩略图、多目标批量截图与自动并排图（sheet.png）、局部元素裁剪（selector）、交互状态序列、录屏取证或像素比对。本地 HTML 自动以工作区根目录启动静态服务，支持 ../assets/ 等相对路径。',
        parameters: {
          target: {
            ...stringOrStrings,
            description:
              '本地 HTML 文件、候选目录（如 explore）、manifest.json、HTTP(S) 地址，或多目标数组/逗号分隔路径。',
          },
          out: {
            type: 'string',
            description: '工作区内输出 PNG 文件或目录路径；多状态连拍、多尺寸、证据集与录屏须传目录。',
          },
          mode: {
            type: 'string',
            enum: ['shot', 'compare', 'evidence'],
            description: '执行模式：shot（单图/多图）、compare（像素比对）、evidence（交付证据集）。',
          },
          before: { type: 'string', description: '比较前的本地图像路径，作为 compare 的别名。' },
          after: { type: 'string', description: '比较后的本地图像路径；传入后生成并排对比。' },
          compare: { type: 'string', description: '用于像素比较的本地参考图路径。' },
          size: {
            type: 'string',
            description: '视口尺寸或预设，默认 1440x900；支持 desktop、mobile、1440x900，可逗号分隔多个尺寸。',
          },
          viewport: { type: 'string', description: '截图视口尺寸，作为 size 的别名。' },
          states: { ...stringOrStrings, description: '状态名称数组或逗号分隔字符串，通过地址参数打开。' },
          param: { type: 'string', description: '状态地址参数名，默认 state。' },
          query: { type: 'string', description: '附加到页面地址的额外查询参数（如 theme=dark&lang=zh）。' },
          zoom: {
            oneOf: [
              { type: 'number' },
              { type: 'string' },
              { type: 'array', items: { oneOf: [{ type: 'number' }, { type: 'string' }] } },
            ],
            description: '截图像素倍数，可传数值、逗号分隔字符串或倍数数组。',
          },
          fullPage: { type: 'boolean', description: '是否截取整个页面。' },
          thumb: { type: 'boolean', description: '快速缩略图：按 0.5 倍分辨率截视口，缩短等待并跳过默认做法检查。' },
          mask: { type: 'boolean', description: '是否生成遮字图。' },
          sheet: { type: 'boolean', description: '是否生成联系表。' },
          noSheet: { type: 'boolean', description: '多目标批量截图时不自动生成 sheet.png。' },
          mark: { type: 'string', description: '截图标注规则，如 1=.open。' },
          selector: {
            type: 'string',
            description: '只截取匹配元素的区域，自动滚入视口；不与 fullPage、record、motion、entry、evidence 同用。',
          },
          steps: { ...stringOrStrings, description: '交互动作字符串或动作组数组，组内用分号分隔。' },
          record: { ...boolOrString, description: '是否录屏，兼容字符串 true/false。' },
          entry: { type: 'boolean', description: '是否在打开页面前开始录屏。' },
          holdMs: { type: 'integer', description: '交互后的停留时长，单位毫秒，范围 0–120000。' },
          motion: { ...boolOrString, description: '是否探测动效，兼容字符串 true/false。' },
          evidence: { type: 'boolean', description: '是否生成状态、截图和录屏证据集。' },
          stitch: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true, description: '本地图像路径。' },
                    label: { type: 'string', description: '图像标签。' },
                  },
                },
              ],
            },
            description: '拼图输入，每项是本地图像路径或含 path、label 的对象。',
          },
          columns: { type: 'integer', description: '拼图或录屏帧序列的列数。' },
          frames: { oneOf: [{ type: 'integer' }, { type: 'string' }], description: '录屏帧序列的帧数，范围 2–120。' },
          waitMs: { type: 'integer', description: '截图前等待时长，单位毫秒，范围 0–120000。' },
          timeoutScale: { type: 'number', description: '截图引擎内部超时倍数。' },
          dryRun: { type: 'boolean', description: '仅验证截图参数，不启动截图。' },
          timeoutMs: { type: 'integer', description: '工具总超时时长，单位毫秒，最大 900000。' },
        },
        presentCall: (args): GenericCallView => ({
          card: 'generic',
          title: '截图与交互取证',
          kind: 'execute',
          locations: [
            { path: (Array.isArray(args.target) ? args.target[0] : args.target) || 'index.html' },
            ...(args.out ? [{ path: args.out }] : []),
          ],
        }),
        output: nativeOutput,
        execute: async (args, exec) =>
          json(
            await workbench.shoot(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal),
          ),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_media',
        timeoutMs: 905_000,
        isConcurrencySafe: (args) =>
          Boolean(
            args &&
            typeof args === 'object' &&
            (args as { action?: unknown }).action === 'search' &&
            !(args as { out?: unknown }).out,
          ),
        description:
          '从博物馆馆藏、开放版权图库、科学版画、NASA 视频和 3D/PBR 材质库检索真实素材，生成带编号的候选联系表预览，并将选中的素材下载到当前工作目录（自动记录 SOURCES.md 署名与许可信息）。',
        parameters: {
          action: {
            type: 'string',
            enum: ['search', 'preview', 'fetch', 'search_and_fetch'],
            description: '素材操作，默认搜索并下载；传 refs 时默认下载。',
          },
          query: {
            type: 'string',
            description: '搜索关键词；支持用 | 分隔多个备选词（如 "oak planks | belgian oak"）。',
          },
          refs: {
            ...stringOrStrings,
            description: '缓存候选编号（如 C1、T2）或直接下载的素材 URL，支持逗号分隔字符串或数组。',
          },
          dir: { type: 'string', description: '素材输出目录，默认 assets/media。' },
          out: {
            type: 'string',
            description: '单文件 URL 下载时的输出路径（如 assets/photo.jpg），不可覆盖已有文件。',
          },
          kind: {
            type: 'string',
            enum: ['all', 'texture', 'design', 'photo', 'blueprint', 'map', 'plate', 'science', 'video'],
            description: '素材类别。',
          },
          use: {
            type: 'string',
            enum: ['page', 'reference', 'all'],
            description: '素材用途：页面使用、仅供参考或全部。',
          },
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
        presentCall: (args): GenericCallView => {
          const action = args.action ?? (args.refs ? 'fetch' : 'search_and_fetch');
          return {
            card: 'generic',
            title: {
              search: '搜索素材',
              preview: '预览素材候选',
              fetch: '下载素材',
              search_and_fetch: '搜索并下载素材',
            }[action],
            kind: action === 'search' ? 'search' : action === 'preview' ? 'read' : 'fetch',
            locations: [{ path: args.out || args.dir || 'assets/media' }],
          };
        },
        output: nativeOutput,
        execute: async (args, exec) =>
          json(
            await workbench.media(sessionCwd(exec, config.workspaceRoot), args as Record<string, unknown>, exec.signal),
          ),
      }),
    );

    ctx.tools.register(
      defineTool({
        name: 'oil_ui_image',
        timeoutMs: 905_000,
        description:
          '优先调用本机 image-gen；不可用时使用 oiloil 生图。可指定分辨率，在当前工作目录生成图片（mode=generate）或基于参考图编辑（mode=edit）。oiloil 返回其他图片格式时会按实际格式保存并返回实际路径。',
        parameters: {
          prompt: { type: 'string', required: true, description: '生成或编辑图片的提示词描述。' },
          mode: {
            type: 'string',
            enum: ['generate', 'edit'],
            description: '生图模式：generate（文生图）或 edit（基于参考图改图/派生变体，传入 images 时默认 edit）。',
          },
          out: { type: 'string', description: '生成或编辑后的图片输出路径，默认 assets/generated.png。' },
          images: {
            type: 'array',
            items: { type: 'string' },
            description: '工作区内的参考图路径；本机 image-gen 支持 1–16 张，oiloil 支持 1 张。',
          },
          size: {
            type: 'string',
            description: '图片分辨率，可传 1K、2K、4K 或宽x高尺寸；本机 image-gen 也支持 auto。',
          },
          background: {
            type: 'string',
            enum: ['auto', 'opaque', 'transparent'],
            description: '图片背景类型；透明底抠图素材选 transparent。',
          },
          model: { type: 'string', description: '可选的图片模型标识。' },
          force: {
            type: 'boolean',
            description: '是否允许覆盖已有输出文件，默认 false（默认路径重名时自动递增文件名避让）。',
          },
          timeoutMs: { type: 'integer', description: '工具总超时时长，单位毫秒，最大 900000。' },
        },
        presentCall: (args): GenericCallView => ({
          card: 'generic',
          title: (args.mode ?? (args.images?.length ? 'edit' : 'generate')) === 'edit' ? '编辑图片' : '生成图片',
          kind: 'edit',
          locations: [{ path: args.out || 'assets/generated.png' }],
        }),
        output: nativeOutput,
        execute: async (args, exec) =>
          json(await workbench.image(sessionCwd(exec, config.workspaceRoot), args, exec.signal)),
      }),
    );
  });
}
