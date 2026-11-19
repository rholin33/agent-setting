# 案例属性

采用 Obsidian 可识别的 YAML：字符串含冒号、引号等时用可靠 YAML 序列化或正确转义；数组使用 YAML 列表。日期为 YYYY-MM-DD。

| 字段 | 含义 |
|---|---|
| type | 固定 troubleshooting |
| title | 中文可理解的案例标题 |
| created / updated | 建立／本次实际更新日期 |
| status | investigating、resolved、workaround、superseded；未知时 investigating |
| verification | unverified、test-only、live-verified；取实际证据支持的值 |
| verified_on | 最近实际验证日期；未验证则留空 |
| components | 软件／插件名列表 |
| versions | 字符串列表，例如 Magic Context 0.47.0；未知填 unknown |
| platforms | 操作系统／运行环境列表 |
| error_signatures | 可精确搜索的脱敏报错句列表 |
| aliases | 中文症状、常见别名列表 |
| tags | 例如 故障排查、MagicContext；无需 # 前缀 |
| local_patch | 是否仅为本地补丁；true 或 false |
| related | 带引号的 wikilink 列表；只链接实际相关笔记 |

status 与 verification 独立：临时补丁可为 workaround + live-verified。已有测试并不能自动升为 resolved。新增适用版本不能抹去旧版本验证边界。
