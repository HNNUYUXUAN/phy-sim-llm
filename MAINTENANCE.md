# 维护、测试与部署

课堂程序只有 `index.html`，无构建步骤。静态网站上传该文件即可；在线、离线和下载文件应使用相同字节。

```powershell
npm run preview
npm test
npm run test:tools
npm run test:citations
node scripts/verify-reproduction.mjs index.html artifacts/check
node scripts/audit-deployment.mjs index.html artifacts/deploy-check
node scripts/capture-paper-figures.mjs --app index.html --out artifacts/new-figures
```

预览默认端口 4173。测试使用独立端口 4185，拒绝复用另一项目的服务；可用 `PHYSIM_TEST_PORT` 配置测试端口。矩阵验证在独立临时 HTTP 端口运行，并覆盖 file、禁网、DPR 1/2/3、桌面/移动。

依赖：Node.js≥22、Git、固定 Playwright/Chromium（路径见 [AI 指南](docs/AI_REPRODUCTION.md)）。无需本地 npm 依赖或浏览器下载。Firefox/WebKit 未验证。

公开资料分层：首页供教师使用；docs 解释原理与复现；research 保存三次正式实验，研究材料的候选 HTML 不等同于根目录的部署版。

界面修改后重新运行主矩阵与部署测量，再生成截图、更新 SHA-256 清单。网站更新后可用 `node scripts/check-online.mjs https://yslit.yuxuan.wiki/` 比较正文哈希。

Agent 检索入口见 [AGENTS.md](AGENTS.md) 和 [llms.txt](llms.txt)。更新文献信息后，运行引用一致性检查并更新 SHA-256 清单；[citation.json](citation.json)、[CITATION.cff](CITATION.cff) 和 [CITATION.bib](CITATION.bib) 应保持一致。
