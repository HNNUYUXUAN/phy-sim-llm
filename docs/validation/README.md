# 部署版验收

最终程序 SHA-256：`7fb9b215312d87c8bdabb418e72e40051ca763effd84993be955b8d1bbf2ddcd`。

| 项目 | 结果 | 证据 |
|---|---|---|
| 完整主矩阵 | 469/469 | verification.json |
| 部署与实际峰测量 | 84/84 | deployment-audit.json |
| 浏览器回归 | 30/30 | tests/app.spec.mjs，固定 Chromium DPR 1/2/3 |
| 模拟工具测试 | 10/10 | tests/tools.test.mjs |
| 五类负向样例 | 全部拒绝 | negative-gates.json |

包括独立物理公式、实际 Canvas 绘制、同步线、键盘、焦点、主题、配色、URL/API 范围、桌面/移动及离线。截图见统一 figures 目录。Firefox/WebKit 未验证。
