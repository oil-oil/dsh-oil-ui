import Schema from '@deepseek-ai/schemastery';

export interface Config {
  workspaceRoot?: string;
  previewPort: number;
  preferPro: boolean;
  proSkillDir?: string;
  imageGenScript?: string;
  bundledSkill?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().default(''),
  preferPro: Schema.boolean().default(true),
  bundledSkill: Schema.boolean().default(true),
  proSkillDir: Schema.string().default(''),
  imageGenScript: Schema.string().default(''),
  previewPort: Schema.number().min(0).max(65535).default(0),
});
