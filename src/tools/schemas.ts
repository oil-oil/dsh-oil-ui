export const stringOrStrings = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } as const;
export const boolOrString = {
  oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false', '0', '1'] }],
} as const;

const viewportSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true, description: '视口宽度。' },
        height: { type: 'integer', required: true, description: '视口高度。' },
      },
    },
  ],
} as const;

export const manifestSchema = {
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1, description: '清单版本，省略时按 1。' },
        project: { type: 'string', description: '项目名称；省略时不显示。' },
        brief: { type: 'string', description: '设计需求；省略时不显示。' },
        candidates: {
          type: 'array',
          required: true,
          description: '候选方向数组。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', description: '唯一方向编号；省略时自动生成。' },
              name: { type: 'string', description: '方向名称；省略时取 HTML 的 title，再取文件名。' },
              concept: { type: 'string', description: '设计概念；省略时不显示。' },
              typography: { type: 'string', description: '字体方案；省略时不显示。' },
              traits: { type: 'array', items: { type: 'string' }, description: '方向特征；省略时不显示。' },
              palette: { type: 'array', items: { type: 'string' }, description: '十六进制配色；省略时不显示。' },
              kind: { type: 'string', enum: ['html', 'image', 'url'], description: '候选内容类型。' },
              source: { type: 'string', description: '本地候选路径或本地服务 URL。' },
              url: { type: 'string', description: '本地服务 URL，作为 source 的别名。' },
              baseline: { type: 'boolean', description: '是否为基准方向。' },
              interactive: { type: 'boolean', description: '是否允许 HTML 候选交互。' },
              nativeViewport: { ...viewportSchema, description: '候选原始视口。' },
            },
          },
        },
        round: { type: 'string', description: '探索轮次；省略时选择文案不显示轮次。' },
        lang: { type: 'string', enum: ['zh', 'en'], description: '界面语言。' },
        nativeViewport: { ...viewportSchema, description: '共享原始视口。' },
        serve: {
          type: 'object',
          additionalProperties: false,
          description: '本地服务信息。',
          properties: {
            command: { type: 'string', required: true, description: '启动命令。' },
            cwd: { type: 'string', description: '绝对工作目录。' },
            url: { type: 'string', description: '本地服务地址。' },
          },
        },
      },
    },
  ],
} as const;
