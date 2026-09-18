# MIDI 声部分离器

上传 MIDI 文件，按旋律与声部关系自动拆成多个音轨，**输出的每个音轨在同一时刻只有一个音符**。
自带离线钢琴合成试听，处理结果完全在你的浏览器里完成，**文件不会上传到任何服务器**。

在线地址：**https://harveypiggy.github.io/Midi-Voice-Splitter/**

## 文件结构

部署只需要根目录这三个文件，无依赖、无构建步骤：

| 文件 | 作用 |
| --- | --- |
| `index.html` | 页面结构与交互逻辑 |
| `midi-core.js` | MIDI 解析、声部分离算法、MIDI 生成 |
| `synth.js` | Web Audio 钢琴/打击乐合成器与播放器 |
| `build-single.js` | 可选：把上面三个打包成一个可离线分发的 HTML |

## 本地运行

直接双击 `index.html` 即可（项目只用普通 `<script>` 标签，`file://` 协议下可以正常工作）。
如果浏览器策略较严，用任意静态服务器：

```bash
npx serve .
# 或
python -m http.server 8000
```

## 发布到 GitHub（用 GitHub Desktop）

仓库已经初始化好了，你只需要四步：

1. 打开 GitHub Desktop → **File → Add local repository** → 选择 `midi-voice-splitter` 这个文件夹
2. 左下方 Summary 填一句说明，比如 `Initial commit` → 点 **Commit to main**
3. 顶部出现蓝色的 **Publish repository** → 点它
   - Name 填仓库名，例如 `midi-voice-splitter`
   - **务必取消勾选 "Keep this code private"**——私有仓库用不了免费的 GitHub Pages
   - 点 **Publish Repository**
4. 打开仓库网页：Desktop 里 **Repository → View on GitHub**（快捷键 `Ctrl+Shift+G`）
   → 点顶部最右边的标签 **Settings** → 左侧栏 **Pages**

   > 看不到 Settings？窗口偏窄时它会被收进标签栏末尾的 `···` 里，点开就能找到。
   > 还有个更快的办法：在仓库页地址栏末尾直接加 `/settings/pages` 回车，
   > 也就是 `https://github.com/HarveyPiggy/Midi-Voice-Splitter/settings/pages`。

5. Source 选 **Deploy from a branch**，Branch 选 `main`、目录选 `/ (root)` → **Save**
6. 等 1–2 分钟，站点就发布在 `https://harveypiggy.github.io/Midi-Voice-Splitter/`。

> 只有仓库所有者才看得到 Settings。如果这个仓库建在某个组织下且你看不到 Settings，
> 找组织管理员要权限，或者改在自己账号下建。
> 私有仓库配 Pages 需要 GitHub Pro。若不想公开源码，跳过这里，改用下面的 Cloudflare Pages。

## 发布后用命令行（可选）

不想点鼠标时，也可以：

```bash
git init -b main
git add .
git commit -m "Initial commit: MIDI voice splitter"
git remote add origin https://github.com/HarveyPiggy/Midi-Voice-Splitter.git
git push -u origin main
```

推送需要身份验证：GitHub 已不支持账号密码推送，请到 GitHub → Settings → Developer settings →
Personal access tokens 生成一个带 `repo` 权限的 token，推送时用户名填账号、密码填这个 token。
用 GitHub Desktop 登录则不需要这一步。

改完 index.html 后别忘了一起更新 `<meta property="og:url">` 里的地址，它控制分享时的链接预览。

## 部署到 Cloudflare Pages（推荐，可私有仓库）

1. 仓库推到 GitHub 或 GitLab 后，进入 Cloudflare 控制台 → **Workers & Pages → Create → Pages → Connect to Git**
2. 选中你的仓库，构建配置填：

| 配置项 | 值 |
| --- | --- |
| Framework preset | None |
| Build command | （留空） |
| Build output directory | `/` |

3. 保存并部署，会得到一个 `*.pages.dev` 域名，国内访问通常比 GitHub Pages 稳定。
4. 国内测速不理想时，可在 **Custom domains** 绑定自己的域名——注意使用国内 CDN/域名需要域名已完成 ICP 备案。

## 自定义域名

在仓库根目录放一个名为 `CNAME` 的文件，内容只写域名一行，例如：

```
midi.example.com
```

然后在你的域名服务商处添加一条 `CNAME` 记录，指向 `harveypiggy.github.io`（GitHub Pages）
或 Cloudflare 给出的 `*.pages.dev`（Cloudflare Pages）。

## 更新发布后的站点

改动文件后重新提交即可，两个平台都会自动重新部署：

```bash
git add .
git commit -m "描述这次改动"
git push
```

## 打包成单个 HTML 文件

想离线发给别人、或作为 Release 附件发布时：

```bash
node build-single.js
```

会在 `dist/` 下生成一个约 68 KB、零外部依赖的 `MIDI声部分离器.html`，双击即可在没有网络的电脑上使用。
（`dist/` 已在 `.gitignore` 中忽略，不进仓库。）

## 隐私说明

页面加载后所有计算都在浏览器内完成：MIDI 解析、声部分离、音频合成均为本地代码，
没有任何网络请求，也没有 localStorage 之类的本地存储。可以把这一点放心写进你的分享文案。
