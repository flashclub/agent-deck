#!/usr/bin/env node
/**
 * AgentDeck Browser MCP — 零依赖 MCP stdio server
 *
 * 把 AgentDeck 的浏览器桥接命令包装成 MCP 工具，供 pi / Claude Code / Codex 等原生调用：
 *   pi mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs
 *   claude mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs
 *   codex mcp add agentdeck-browser -- node /path/to/agent-deck/mcp.mjs
 *
 * 本进程只是薄壳：工具调用 → POST http://127.0.0.1:$AG_PORT/api/browser/cmd → 插件执行。
 * 前置条件：node server.mjs 在跑、Chrome 装好 extension/ 并完成配对。
 * 注意：stdout 只能输出协议 JSON，一切日志走 stderr。
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.AG_PORT || process.env.AGDECK_PORT || 7788);
const API = `http://127.0.0.1:${PORT}/api/browser/cmd`;
const SERVER_INFO = { name: "agentdeck-browser", version: "0.1.0" };

const TOOL_DEFS = [
	{
		name: "browser_navigate",
		description: "Open a URL in the paired local browser (via AgentDeck extension) and wait for the page to load. Tabs live inside a dedicated 'AgentDeck' tab group — the user's own tabs are never touched. Returns tabId, url and title.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "Absolute URL to open" },
				tabId: { type: "number", description: "Optional explicit target tab id" },
			},
			required: ["url"],
		},
	},
	{
		name: "browser_screenshot",
		description: "Take a PNG screenshot of the browser tab. Returns the image inline (visible to multimodal models) plus the file path on disk (~/.agent-deck/shots/).",
		inputSchema: {
			type: "object",
			properties: { tabId: { type: "number", description: "Optional explicit target tab id" } },
		},
	},
	{
		name: "browser_click",
		description: "Click an element on the page by CSS selector (auto-scrolls it into view first).",
		inputSchema: {
			type: "object",
			properties: {
				selector: { type: "string", description: "CSS selector, e.g. #submit or a.search" },
				tabId: { type: "number" },
			},
			required: ["selector"],
		},
	},
	{
		name: "browser_eval_js",
		description: "Evaluate a JavaScript expression in the page (main world). Supports awaiting promises. Returns the JSON-serializable value.",
		inputSchema: {
			type: "object",
			properties: {
				expression: { type: "string", description: "JS expression, e.g. document.title or (await fetch('/api/x')).status" },
				tabId: { type: "number" },
			},
			required: ["expression"],
		},
	},
	{
		name: "browser_read_text",
		description: "Read the page's visible text (body.innerText). Use for understanding page content after navigation.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "Max characters (default 40000, hard cap 200000)" },
				tabId: { type: "number" },
			},
		},
	},
	{
		name: "browser_tabs_list",
		description: "List all open browser tabs (id, title, url, active, agentGroup). agentGroup:true marks tabs inside the dedicated AgentDeck tab group.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "browser_close_tab",
		description: "Close a browser tab (defaults to the agent's own tab).",
		inputSchema: {
			type: "object",
			properties: { tabId: { type: "number" } },
		},
	},
];

async function callBrowser(op, args, extra = {}) {
	let res;
	try {
		res = await fetch(API, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ op, args, ...extra }),
		});
	} catch {
		throw new Error(`AgentDeck server unreachable at ${API} — run \`node server.mjs\` in the agent-deck repo first`);
	}
	let j = {};
	try { j = await res.json(); } catch {}
	if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
	return j;
}

const textBlock = (text) => ({ type: "text", text: String(text) });
const textResult = (text) => ({ content: [textBlock(text)] });

async function runTool(name, a = {}) {
	switch (name) {
		case "browser_navigate": {
			if (!a.url) throw new Error("url is required");
			return textResult(JSON.stringify(await callBrowser("navigate", { url: a.url, tabId: a.tabId })));
		}
		case "browser_screenshot": {
			const r = await callBrowser("screenshot", { tabId: a.tabId }, { inline: true });
			let png = r.pngBase64;
			if (!png && r.path) {
				try { png = readFileSync(r.path).toString("base64"); } catch {}
			}
			if (!png) throw new Error("screenshot returned no image data");
			return {
				content: [
					{ type: "image", data: png, mimeType: "image/png" },
					textBlock(`Screenshot saved: ${r.path}\nURL: ${r.url}\nTitle: ${r.title}`),
				],
			};
		}
		case "browser_click": {
			if (!a.selector) throw new Error("selector is required");
			return textResult(JSON.stringify(await callBrowser("click", { selector: a.selector, tabId: a.tabId })));
		}
		case "browser_eval_js": {
			if (typeof a.expression !== "string") throw new Error("expression is required");
			const r = await callBrowser("eval_js", { expression: a.expression, tabId: a.tabId });
			return textResult(JSON.stringify(r.value ?? null));
		}
		case "browser_read_text": {
			const r = await callBrowser("read_text", { limit: a.limit, tabId: a.tabId });
			return textResult(`URL: ${r.url}\nTitle: ${r.title}\n\n${r.text}${r.truncated ? "\n…(truncated)" : ""}`);
		}
		case "browser_tabs_list":
			return textResult(JSON.stringify((await callBrowser("tabs_list", {})).tabs, null, 1));
		case "browser_close_tab":
			return textResult(JSON.stringify(await callBrowser("close_tab", { tabId: a.tabId })));
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

/* ---------------- JSON-RPC over stdio ---------------- */

const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

async function handle(msg) {
	if (typeof msg.method !== "string") return;
	const isRequest = msg.id !== undefined && msg.id !== null;

	if (msg.method === "initialize") {
		const requested = msg.params?.protocolVersion;
		write({
			jsonrpc: "2.0", id: msg.id,
			result: {
				protocolVersion: typeof requested === "string" ? requested : "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			},
		});
		return;
	}
	if (msg.method === "notifications/initialized") return;
	if (msg.method === "ping") {
		if (isRequest) write({ jsonrpc: "2.0", id: msg.id, result: {} });
		return;
	}
	if (msg.method === "tools/list") {
		write({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOL_DEFS } });
		return;
	}
	if (msg.method === "tools/call") {
		const { name, arguments: args } = msg.params || {};
		try {
			if (!TOOL_DEFS.some((t) => t.name === name)) throw new Error(`unknown tool: ${name}`);
			write({ jsonrpc: "2.0", id: msg.id, result: await runTool(name, args || {}) });
		} catch (e) {
			write({ jsonrpc: "2.0", id: msg.id, result: { content: [textBlock(String(e?.message || e))], isError: true } });
		}
		return;
	}
	if (isRequest) {
		write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
	}
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	line = line.trim();
	if (!line) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	handle(msg).catch((e) => {
		if (msg?.id !== undefined && msg?.id !== null) {
			write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } });
		}
	});
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
