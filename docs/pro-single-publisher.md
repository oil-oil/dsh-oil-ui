# Pro 的唯一发布者

最终决定：`oil-ui-pro` 原文本身可以在 DSH 中使用，由标准 preset 的 filesystem Provider 直接发布。插件不发布同名 Pro、不改写正文，不读取 Pro 私有适配规则，也不生成 Pro 编译或评审手册缓存。内置公开 `oil-ui` Lite 由插件原样发布，独立安装的 Lite 也由 filesystem 原样发布；无论来源谁胜出，都使用该资源目录中的原文。

## 原因与约束

此前同一个 `oil-ui-pro` 同时来自 filesystem 和插件，全局转换版会被 preset 作用域的 filesystem 原文遮住。再在 Agent 层注册只能改变胜出顺序，仍留下两个发布者。现在仅保留 filesystem 原文；正确性不依赖插件在 Cordis 哪一层注册，也不需要更改 DSH、oil-cli 或共享安装目录。

Pro 的共享 `references/tools.md` 说明：宿主提供截图、素材、生图、对比页工具时优先使用宿主工具，命令行参数映射同名字段，来源和版本以宿主状态工具为准。正文仍保留宿主无关的任务和参数说明。旧 `adapters/dsh/` 仅供已发布插件 `0.4.9` 兼容；上游标记弃用，计划在 `0.35.0` 移除；上游 metadata.version 达到该版本时必须已删除目录，旧插件兼容期需在此之前结束。

## 模型实际可见的状态

`oil_ui_skill_status` 在调用 Agent 的作用域查询胜出的 Pro，否则查询 Lite。`detected` 仅说明本地发现结果，`effective` 才是模型实际获得的定义。Lite 与 Pro 都验证实际正文与其自身资源目录中的原始 `SKILL.md` 按 Harness filesystem 去除首尾空白后的正文一致、入口路径一致、版本一致且允许模型调用。标签或 rank 不作为成功依据。

- `skillReady=true`、`nativeSkillReady=true`、`visibleMatchesOriginal=true`、`skillLoadState=ready`：实际原文与资源一致。`nativeSkillReady` 仅为兼容别名，不再表示“已转换”。
- `overridden`：正文、资源目录、版本或入口路径不一致。
- `unavailable`：未发布或禁止模型调用。

发现到 Claude/Codex 等安装目录只用于本地诊断和工作区资源选择，不能让 DSH 模型看见该 Skill。需要将 Pro 安装到 Harness 自己扫描的目录，例如 `~/.agents/skills` 或 `~/.dsh/skills`；`proSkillDir` 不注册 Provider。插件 Host、preset、Agent 任何层都不得注册 `oil-ui-pro`。

## 防回归与交付

离线测试只用临时虚构 Pro，覆盖唯一发布者、错误胜出定义和手册新鲜读取。`npm run smoke:dsh` 使用真实 CLI 安装包并启动 Host 和标准 preset Agent，检查模型目录恰有一个 filesystem Pro、原文不变、状态正常、五个工具与 Lite 版本正确。它不启动模型、不调用付费服务、不读真实 HOME。

插件和 Pro 配对发版的顺序见 [releasing.md](releasing.md#和-pro-配对发版)。
