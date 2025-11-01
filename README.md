# Zhihu Publisher

仅保留知乎专栏发布功能的精简版 VS Code 扩展。

## 功能
- 获取当前活动 Markdown 文档内容
- 启动 Puppeteer 浏览器自动登录知乎（支持扫码）
- 打开写作页并通过模态框导入 Markdown 文件
- 自动填写标题（移除文件扩展名）

## 快速开始（普通使用）
1. 安装依赖：`npm install`
2. 构建：`npm run compile`
3. 在 VS Code 命令面板执行：`发布当前 Markdown 到知乎`

### 扩展激活说明
扩展设置了 `activationEvents: onCommand:zhihu.publishMarkdown`，只有在命令面板搜索该命令或被其它扩展调用时才会激活。如果安装后找不到命令：
- 确认扩展已启用且未被禁用
- 在命令面板输入关键字 “知乎” 或 “publishMarkdown”
- 查看“开发者工具” Console 是否有加载错误（如 Puppeteer 缺失）
- 使用 VS Code 菜单：帮助 -> 切换开发者工具，输入 `require("vscode").extensions.getExtension("your-name.zhihu-publisher-extension")?.isActive` 检查是否激活

## 调试开发
本仓库已包含 `.vscode/launch.json` 与 `tasks.json`：

### F5 调试流程
1. 运行面板选择 `Run Extension` 或直接按 F5。
2. 会启动一个 Extension Development Host 窗口。
3. 在该新窗口中打开 Markdown 文件并执行命令。
4. 在 `src/` 中直接设置断点，因开启 `sourceMap` 可映射到 TS 源。

### 增量编译
`launch.json` 中使用 `preLaunchTask: tsc: watch`，调试开始后自动进入 TypeScript watch 模式，保存文件即自动重新编译到 `dist/`。

### Puppeteer 浏览器
- 默认 `headless: false` 方便扫码与视觉确认。
- 若需要指定已有 Chrome/Chromium，可设置环境变量：`PUPPETEER_EXECUTABLE_PATH=/path/to/chrome` 后再 F5。

### 常见问题排查
| 场景 | 解决思路 |
| ---- | -------- |
| 浏览器无法启动 | 检查 Linux 依赖 (如 libatk-bridge2.0-0, libgbm1)。尝试安装或改用系统 Chrome。 |
| 登录一直等待 | 看是否跳转到二维码页面，超时后重试；确保网络可访问微信登录。 |
| 断点不命中 | 确认 watch 正在运行；查看 `dist/*.js.map` 是否生成。重新启动调试实例可恢复。 |
| 上传失败提示未找到 input | 可能知乎前端结构更新，更新选择器逻辑 `publisher.ts`。 |
| 命令显示但执行报 not found | 扩展激活失败，检查开发者工具 Console 是否有依赖缺失错误。 |
| 加载 puppeteer 失败缺 cosmiconfig | `.vscodeignore` 过度排除，保留完整 `node_modules` 或仅移除 docs/test。 |

### 打包注意事项
Puppeteer 依赖链包含 `puppeteer-core`, `@puppeteer/browsers`, `chromium-bidi`, `cosmiconfig` 等。如果在 `.vscodeignore` 中排除整个 `node_modules` 再做选择性白名单，很容易漏掉深层依赖导致运行期报错。推荐初期做法：

1. 保留完整 `node_modules` 仅排除 `**/test`, `**/docs` 等。
2. 确认命令执行正常后再考虑：
	- 改用 `puppeteer-core` + 系统浏览器：减少 VSIX 体积。
	- 使用打包工具（esbuild/webpack）内联业务代码并 external `puppeteer`。
3. 遇到 `Cannot find package 'cosmiconfig'` 等错误：撤销对 `node_modules` 的大范围排除，重新打包验证。

懒加载策略：扩展激活时不加载 puppeteer，命令执行时动态 `import('puppeteer')`，降低激活失败风险。

## 注意
- Puppeteer 默认非 headless，方便扫码与观察流程
- 导入失败时请检查知乎页面结构是否变更
- 目前仅支持 docx/md 的模态框导入路径

## 后续增强建议
- 增加重试与超时策略
- 内容完整性验证与提示
- 支持图片自动上传

## 许可
MIT
