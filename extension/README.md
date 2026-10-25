# AgentDeck Bridge (Chrome 扩展,实验性)

让 AgentDeck 里的 coding agent 拥有"眼睛和手":操作你的真实浏览器——导航、点击、截图(存盘供 agent 读图)、执行 JS、读页面文本、列标签页。

本机专属:插件只连 `ws://127.0.0.1:7788/ext`,且必须持有配对 token。数据不出你的机器。

## 安装

1. 启动 AgentDeck:`node server.mjs`
2. Chrome 打开 `chrome://extensions` → 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选择本 `extension/` 目录
3. 在 AgentDeck 网页顶栏点 **「连接浏览器」**:
   - 服务端向扩展发起配对，浏览器自动弹出确认窗口 → 点 **「同意连接」** → 完成
   - 顶栏按钮变绿显示「浏览器已连接」；token 全自动保存与续期，无需手动处理
4. 首次使用时在扩展 popup 里点 **Grant access to all sites…**（chrome.debugger 附加页面必需）

## agent 怎么用

### 方式 A:MCP 工具(推荐,零拼装)

在 agent 的 MCP 配置里加一行,浏览器操作就变成原生工具(`browser_navigate` / `browser_screenshot` / `browser_click` / `browser_eval_js` / `browser_read_text` / `browser_tabs_list` / `browser_close_tab`):

```bash
# pi
pi mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs

# Claude Code
claude mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs

# Codex
codex mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs
```

然后把路径换成你的 agent-deck 仓库路径即可。`browser_screenshot` 会把图片**内联返回**给多模态模型(同时落盘 `~/.agent-deck/shots/`)。

### 方式 B:curl(零依赖,任何能跑命令的 agent 都行)

```bash
API=http://127.0.0.1:7788/api/browser/cmd

# 打开页面(等待加载完成;复用插件的 agent 标签页,没有则新建/接管当前页)
curl -s $API -d '{"op":"navigate","args":{"url":"https://example.com"}}'

# 截图 → 存到 ~/.agent-deck/shots/xxx.png,agent 直接用多模态读这个文件
curl -s $API -d '{"op":"screenshot"}'

# 点击(CSS 选择器,自动滚动到元素)
curl -s $API -d '{"op":"click","args":{"selector":"#submit"}}'

# 执行 JS(支持 await Promise)
curl -s $API -d '{"op":"eval_js","args":{"expression":"document.title"}}'

# 读页面文本(最多 40k 字符)
curl -s $API -d '{"op":"read_text","args":{}}'

# 列出所有标签页 / 关闭 agent 标签页
curl -s $API -d '{"op":"tabs_list"}'
curl -s $API -d '{"op":"close_tab"}'
```

所有命令支持 `args.tabId` 显式指定目标标签页;截图命令加 `"inline": true`(body 顶层)可让响应直接带 base64 图片(MCP 桥接即如此)。

**标签页隔离(Codex 式)**:agent 拥有**专属窗口**(自动创建,不抢焦点),窗口内再设紫色标签组「AgentDeck」——agent 的所有标签都开在那里,你的窗口既不会有它的标签,也永远看不到调试横幅(横幅是窗口级的,关在专属窗口里就与你无关;且只有 `eval_js`/`screenshot` 瞬间触发)。想让它操作某个已有页面,让它先 `tabs_list` 找到 id 再传 `args.tabId`,或把那个标签拖进 AgentDeck 窗口。

### 完整示例:改码 → 看效果 → 再改

```bash
API=http://127.0.0.1:7788/api/browser/cmd
curl -s $API -d '{"op":"navigate","args":{"url":"http://localhost:3000"}}'
curl -s $API -d '{"op":"screenshot"}'
# → {"ok":true,"path":"/Users/you/.agent-deck/shots/shot-...png",...}
# agent 用多模态读这个 PNG,自己判断页面效果
```

## 安全模型(P0 现状)

- **一键配对**：AgentDeck UI 点「连接浏览器」→ 服务端向已连接的扩展推配对请求 → 用户在浏览器弹窗点「同意」→ token 自动保存。nonce 一次性、2 分钟过期
- **网页隔离**：插件 WS 信道在握手层拒绝一切 `https://`/`http://` Origin（真实扩展连接是 `chrome-extension://`，本地进程无 Origin），恶意网页无法连 `ws://127.0.0.1` 抡答配对或驱动浏览器；HTTP API 同样拒绝带外部 Origin 的请求
- **调试横幅最小化**：只有 `eval_js` / `screenshot` 瞬间会闪现 Chrome「已开始调试」横幅（用完即断）；`navigate` / `click` / `read_text` 走 `chrome.scripting` / tabs API，全程无横幅
- **已知边界(P2 解决)**:域名防火墙、专用浏览器 Profile、敏感操作(密码框/支付页)人工确认、审计日志——当前版本 agent 拿到的权限等于"你的浏览器",**只在你信任的 agent 和任务上使用**

## 能力边界

- chrome.debugger 附加不了 `chrome://` 内部页
- 非信任事件的 `el.click()` 对极少数页面不够(需要受信输入的场景,后续用 CDP Input 域补)
- MV3 要求 Chrome 116+(WebSocket 保活依赖)
