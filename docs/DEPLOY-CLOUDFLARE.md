# 部署官网与反馈接口（Cloudflare Pages）

官网代码在仓库的 `website/`，反馈接口是 `website/functions/api/feedback.js`。Cloudflare Pages 会同时托管 Astro 静态页面和 `/api/feedback` 函数。

反馈写入私有仓库 **`Jorgut/pareno-feedback`**（已创建，private，Issues 已开启）。仓库里的 GitHub token 只存在 Cloudflare 环境变量中，不会进入插件或前端代码。

## 0. 自动化部署（二选一）

仓库已经带了两条 GitHub Actions：

- `.github/workflows/ci.yml`：每次 push/PR 跑插件 typecheck、测试、构建，以及官网 Astro 构建。
- `.github/workflows/deploy-website.yml`：push 到 `main` 的 `website/**` 变更时，构建并部署到 Cloudflare Pages。

### 方式 A：GitHub Actions 自动部署（推荐）

仓库的 `.github/workflows/deploy-website.yml` 会在 push 到 `main` 时自动：

1. 构建 `website/`；
2. 创建 Pages 项目（如果不存在）；
3. 把反馈 token 和收件库名写入 Cloudflare Pages secrets；
4. 用 Wrangler 部署 `dist/` 和 `website/functions/`。

你只需要在 GitHub 仓库 Settings → Secrets and variables → Actions 添加：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限：Account → Cloudflare Pages: Edit（可用 “Edit Cloudflare Workers” 模板后补 Pages 权限） |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard 右侧的 Account ID |
| Secret | `FEEDBACK_GITHUB_TOKEN` | fine-grained token，只给 `Jorgut/pareno-feedback` 的 Issues 读写 |
| Variable（可选） | `CLOUDFLARE_PAGES_PROJECT` | Pages 项目名，默认 `parenowriter` |

Cloudflare API Token 创建：Dashboard → **My Profile → API Tokens → Create Token**。不需要 `wrangler login`，也没有限时 OAuth。

然后 push 到 `main`（或手动触发 workflow），部署完成后访问 `https://<项目名>.pages.dev`。首次创建 Direct Upload 项目后不能改成 Git 集成；如果要用方式 B，请从一开始就选 B。

### 方式 B：Cloudflare Pages Git 集成

如果不想在 GitHub 存 Cloudflare token，也可以用 Cloudflare Dashboard 连仓库：

- Workers & Pages → Create → Pages → Connect to Git → 选 `Jorgut/pareno`
- Root directory：`website`；Build command：`npm run build`；Output：`dist`
- 环境变量同上（`FEEDBACK_GITHUB_TOKEN`、`FEEDBACK_REPO`、`NODE_VERSION=22`）
- 之后每次 push 自动部署，不需要 `.github/workflows/deploy-website.yml`（可删掉或禁用，避免重复部署）。

## 1. 创建 fine-grained GitHub token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
2. Resource owner：`Jorgut`。
3. Repository access：**Only select repositories** → `Jorgut/pareno-feedback`。
4. Repository permissions：
   - **Issues: Read and write**（必需）
   - **Metadata: Read-only**（GitHub 自动保留）
   - 其他权限不授予。
5. 设置较短有效期（例如 90 天），生成后复制 token。不要把 token 放进源码、聊天记录或提交。

## 2. 在 Cloudflare 建 Pages 项目

1. 打开 Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git**。
2. 选择仓库 `Jorgut/pareno`，项目名建议 `parenowriter`（若被占用可用 `pareno-site`）。
3. 构建设置：
   - **Root directory**：`website`
   - **Build command**：`npm run build`
   - **Build output directory**：`dist`
   - **Node version**：`22`（环境变量 `NODE_VERSION=22`，Astro 7 需要 Node 22.23+）
4. **Environment variables**（Production，必要时也配 Preview）：
   - `FEEDBACK_GITHUB_TOKEN`：上一步的 token（设为 Secret）
   - `FEEDBACK_REPO`：`Jorgut/pareno-feedback`
5. Save and Deploy。当前生产项目为 `parenowriter`，地址是 `https://parenowriter.pages.dev`。

> `functions/` 目录必须在 Pages 项目的根目录（即 `website/functions`）。当前配置已满足；不要把它移到 `dist/`。

## 3. 验证反馈接口

先看开关状态：

```bash
curl -s https://<项目名>.pages.dev/api/feedback
# {"enabled":true}
```

再提交一条测试反馈：

```bash
curl -s -X POST https://<项目名>.pages.dev/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"category":"接入验证","message":"[PARENO] 接入验证：请确认私有收件库收到这条 issue。","environment":"manual curl test"}'
# {"ok":true,"receipt":"..."}
```

然后打开 `https://github.com/Jorgut/pareno-feedback/issues`，确认出现标题为 `[PARENO] 接入验证` 的 issue；测试完可以关闭或删除。

网站 `/feedback` 页面的表单也走同一个接口，部署后在浏览器里提交一条即可。

## 4. 把插件接到反馈接口

把部署域名填入 `src/feedback.ts`：

```ts
export const FEEDBACK_SUBMIT_ENDPOINT = 'https://<项目名>.pages.dev/api/feedback';
```

然后：

```bash
npm run typecheck
npm test
npm run build
```

重新发布 `main.js`。在 Obsidian 里打开反馈窗口，提交一条带「接入验证」标记的反馈，确认私有仓库收到 issue。

同时把 `website/astro.config.mjs` 的 `site` 改成正式地址（用于 canonical/OG）：

```js
site: 'https://<项目名>.pages.dev'
```

## 5. 自定义域名（可选）

1. 在 Cloudflare 里添加并托管域名（或把已有域名 NS 指到 Cloudflare）。
2. Pages 项目 → **Custom domains → Set up a custom domain**，例如 `pareno.example.com`。
3. SSL 会自动签发；把 `astro.config.mjs` 的 `site` 和插件的 `FEEDBACK_SUBMIT_ENDPOINT` 改成新域名。

没有自定义域名时 `*.pages.dev` 完全可用，只是不如正式域名好看。

## 6. 本地开发与调试

```bash
cd website
npm install
ASTRO_TELEMETRY_DISABLED=1 npm run dev          # 页面：http://localhost:4321
ASTRO_TELEMETRY_DISABLED=1 npm run build        # 产物：website/dist
npx wrangler pages dev dist                     # 带 /api/feedback 本地调试
```

本地调试函数时，在 `website/.dev.vars`（不要提交）写：

```text
FEEDBACK_GITHUB_TOKEN=github_pat_...
FEEDBACK_REPO=Jorgut/pareno-feedback
```

## 安全与维护

- token 只授予 `Jorgut/pareno-feedback` 的 Issues 读写；到期前轮换，更新 Cloudflare 环境变量后重新部署。
- 反馈接口是公开端点，当前有 JSON/字段/大小校验、蜜罐和 Markdown 转义；Cloudflare 免费计划可以在 WAF 里加限流规则，防止被脚本刷 issue。
- 函数不会把 GitHub 的响应、token、仓库名或反馈原文写进日志或返回给客户端。
- 如果以后加自定义域名、邮件通知或数据库，优先在 Cloudflare 侧扩展，插件只保留一个 `FEEDBACK_SUBMIT_ENDPOINT`。
