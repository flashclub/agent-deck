/**
 * MCP 桥接测试（不需要 Chrome 也不需要真 MCP client——模拟 stdio JSON-RPC 与假插件回包）
 * 覆盖：initialize 握手、tools/list、工具调用（navigate/screenshot 图片块/错误传播）、未知方法
 * 运行：node test/mcp-bridge.mjs
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO_DIR = join(import.meta.dirname, "..");
const PORT = 7797;
const TOKEN = "mcp-test-token";

let failures = 0;
const ok = (cond, label) => {
	console.log((cond ? "✅" : "❌") + " " + label);
	if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 起 AgentDeck 服务 + 假插件 */
const server = spawn(process.execPath, [join(REPO_DIR, "server.mjs"), String(PORT)], {
	cwd: REPO_DIR,
	env: { ...process.env, AG_RECENTS: "0", AG_EXT_TOKEN: TOKEN },
	stdio: "ignore",
});
await wait(1200);
const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
const seenOps = [];
ext.on("open", () => ext.send(JSON.stringify({ t: "ext-hello", token: TOKEN })));
ext.on("message", (raw) => {
	const m = JSON.parse(raw.toString());
	if (m.t !== "cmd") return;
	seenOps.push(m.op);
	const data = m.op === "screenshot"
		? { pngBase64: Buffer.from("MCP-PNG").toString("base64"), url: "https://example.com", title: "Example" }
		: { echo: m.op, tabId: 1, url: "https://example.com" };
	if (m.op === "eval_js") ext.send(JSON.stringify({ t: "cmd-result", id: m.id, ok: false, error: "boom: page crashed" }));
	else ext.send(JSON.stringify({ t: "cmd-result", id: m.id, ok: true, data }));
});
await wait(500);

/* 起 MCP server 子进程（stdout 是协议通道，必须逐行读） */
const mcp = spawn(process.execPath, [join(REPO_DIR, "mcp.mjs")], {
	cwd: REPO_DIR,
	env: { ...process.env, AG_PORT: String(PORT) },
	stdio: ["pipe", "pipe", "inherit"],
});
const responses = new Map();
let seq = 0;
createInterface({ input: mcp.stdout }).on("line", (line) => {
	try {
		const m = JSON.parse(line);
		responses.set(m.id, m);
	} catch {}
});
const rpc = (method, params) => new Promise((resolve) => {
	const id = ++seq;
	responses.delete(id);
	mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
	const t0 = Date.now();
	const poll = () => {
		if (responses.has(id)) return resolve(responses.get(id));
		if (Date.now() - t0 > 8000) return resolve(null);
		setTimeout(poll, 50);
	};
	poll();
});

try {
	/* 1) initialize 握手 */
	const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
	ok(init?.result?.serverInfo?.name === "agentdeck-browser", "initialize 返回 serverInfo");
	ok(init?.result?.protocolVersion === "2024-11-05", "协议版本兼容");
	ok(!!init?.result?.capabilities?.tools, "声明 tools 能力");

	/* 2) tools/list */
	const list = await rpc("tools/list", {});
	const names = (list?.result?.tools || []).map((t) => t.name);
	ok(names.length === 7 && names.every((n) => n.startsWith("browser_")), `7 个 browser_* 工具 (${names.join(", ")})`);
	const nav = list.result.tools.find((t) => t.name === "browser_navigate");
	ok(nav?.inputSchema?.required?.includes("url"), "工具带 inputSchema");

	/* 3) 工具调用：navigate */
	const call1 = await rpc("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } });
	ok(call1?.result?.content?.[0]?.type === "text" && call1.result.content[0].text.includes("example.com"), "navigate 返回文本结果");
	ok(seenOps.includes("navigate"), "命令确实转发到了插件");

	/* 4) 工具调用：screenshot → image 内容块 */
	const call2 = await rpc("tools/call", { name: "browser_screenshot", arguments: {} });
	const img = (call2?.result?.content || []).find((c) => c.type === "image");
	ok(!!img && img.mimeType === "image/png" && img.data.length > 0, "screenshot 返回内联 image 内容块");
	ok((call2.result.content || []).some((c) => c.type === "text" && c.text.includes(".agent-deck/shots/")), "同时给出落盘路径");

	/* 5) 错误传播 */
	const call3 = await rpc("tools/call", { name: "browser_eval_js", arguments: { expression: "1+1" } });
	ok(call3?.result?.isError === true && /boom/.test(call3.result.content?.[0]?.text || ""), "插件错误以 isError 结果传播");

	/* 6) 未知方法 → -32601；未知工具 → isError */
	const bad = await rpc("resources/list", {});
	ok(bad?.error?.code === -32601, "未知方法返回 -32601");
	const badTool = await rpc("tools/call", { name: "browser_frobnicate", arguments: {} });
	ok(badTool?.result?.isError === true && /unknown tool/.test(badTool.result.content?.[0]?.text || ""), "未知工具报 isError");

	console.log(failures ? `\n${failures} 项失败` : "\n全部通过 🎉");
} catch (err) {
	console.error("测试异常:", err);
	failures++;
} finally {
	try { mcp.kill(); } catch {}
	rmSync(join(homedir(), ".agent-deck", "shots"), { recursive: true, force: true });
	server.kill();
	process.exit(failures ? 1 : 0);
}
