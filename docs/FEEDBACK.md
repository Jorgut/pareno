# 反馈收件说明

PARENO 的反馈入口有三处：Obsidian 侧栏底部、设置页「反馈与支持」，以及官网的 `/feedback` 页面。三者都提交到同一个端点：

```
插件 / 官网表单
      ↓  POST /api/feedback
Cloudflare Pages Function（服务端持有 GitHub token）
      ↓
私有仓库 Jorgut/pareno-feedback 的 Issues
```

用户不需要 GitHub 账号；反馈不会公开，也不会自动附带笔记内容、文件路径或密钥。

## 为什么用自己的端点

- Web3Forms 会拒绝非浏览器客户端（Obsidian 的 `requestUrl` 会收到 403/Cloudflare challenge），不能用于插件直连；
- Formspree 需要额外注册表单，而且反馈进邮箱而不是 issue 收件库；
- 自己的 Cloudflare Pages Function 没有这些限制，反馈直接进私有 GitHub Issues，作者能收到通知，也方便后续搜索、分类和关闭。

## 字段

| 字段 | 内容 |
| --- | --- |
| `category` | `问题 / Bug`、`功能建议`、`翻译或建议质量`、`其他` |
| `message` | 用户填写的问题描述，最多 2000 字 |
| `email` | 可选联系邮箱，仅用于回复；可以不填 |
| `environment` | 版本、平台、模型方式与名称、写作语体、自动审校状态；不含笔记内容、路径或密钥 |
| `_subject` | 兼容字段；服务端不依赖它生成 issue 标题 |
| `_gotcha` | 蜜罐字段，正常提交为空 |

成功返回 `201 {"ok":true,"receipt":"..."}`；无效输入返回 400，未配置返回 503，GitHub 投递失败返回 502。函数不会把 GitHub 的响应、token、仓库名或反馈原文写进日志或返回给客户端。

## 隐私边界

- 只有用户主动点击提交才会发送；
- 环境信息是白名单字段，由插件生成，不包含笔记正文、标题、文件路径、库名、API 密钥、Agent 登录令牌或 Pangram 密钥；
- 反馈保存在私有仓库，只有仓库管理员和授权协作者可见；
- 请不要在反馈中填写敏感信息；删除请求可通过反馈入口或 GitHub 联系作者。

## 部署与验证

反馈端点的部署、环境变量、测试命令和插件端点配置见 [DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)。

本地可以运行函数单元测试：

```bash
node --test tests/feedback-function.test.mjs
```

当前 `src/feedback.ts` 的 `FEEDBACK_SUBMIT_ENDPOINT` 已指向 `https://parenowriter.pages.dev/api/feedback`；插件提交按钮可直接使用，复制/GitHub 兜底仍保留。

## 防滥用

接口有 JSON 类型、字段白名单、8 KiB 请求体、2000 字描述、254 字符邮箱和蜜罐校验；GitHub issue 正文会做 Markdown 转义，避免 @提及、图片、HTML 和链接被注入。公开端点仍可能被脚本调用，建议在 Cloudflare WAF 里加限流规则，并定期轮换 token。
