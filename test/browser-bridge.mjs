/**
 * 浏览器桥接协议测试（不需要 Chrome——用假插件客户端模拟 cmd-result 回包）
 * 覆盖：token 认证（错token拒/对token收）、状态查询、未连接报错、Origin 防跨站、
 *       命令往返、截图落盘、插件断线后报错
 * 运行：node test/browser-bridge.mjs
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO_DIR = join(import.meta.dirname, "..");
const PORT = 7798;
const TOKEN = "test-token-abc123";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (cond, label) => {
	console.log((cond ? "✅" : "❌") + " " + label);
	if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [join(REPO_DIR, "server.mjs"), String(PORT)], {
	cwd: REPO_DIR,
	env: { ...process.env, AG_RECENTS: "0", AG_EXT_TOKEN: TOKEN },
	stdio: "ignore",
});
await wait(1200);

const jsonPost = async (path, body, headers = {}) =>
	fetch(BASE + path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});

try {
	/* 1) 插件未连接时命令报错 */
	let r = await jsonPost("/api/browser/cmd", { op: "navigate", args: { url: "https://example.com" } });
	let j = await r.json();
	ok(j.ok === false && /not connected/i.test(j.error), "未连接时明确报错");

	/* 2) 错误/空 token → 不踢掉，进入待配对状态 */
	const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
	let badGotPairNeeded = false;
	bad.on("message", (raw) => { if (JSON.parse(raw.toString()).t === "pair-needed") badGotPairNeeded = true; });
	bad.on("open", () => bad.send(JSON.stringify({ t: "ext-hello", token: "WRONG" })));
	await wait(800);
	ok(badGotPairNeeded, "错误 token 进入待配对状态（pair-needed）");
	bad.close();

	/* 3) 正确 token 配对 */
	const cmds = []; // 假插件收到的命令
	const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
	let helloOk = false;
	ext.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.t === "ext-hello-ok") helloOk = true;
		if (m.t === "cmd") {
			cmds.push(m);
			const data = m.op === "screenshot"
				? { pngBase64: Buffer.from("FAKE-PNG-DATA").toString("base64"), url: "https://example.com", title: "Example" }
				: { echo: m.op, tabId: 1, url: "https://example.com" };
			ext.send(JSON.stringify({ t: "cmd-result", id: m.id, ok: true, data }));
		}
	});
	ext.on("open", () => ext.send(JSON.stringify({ t: "ext-hello", token: TOKEN })));
	await wait(800);
	ok(helloOk, "正确 token 配对成功");

	r = await fetch(`${BASE}/api/browser/status`);
	j = await r.json();
	ok(j.connected === true, "status 显示已连接");

	/* 4) 带 Origin 的请求被拒（防恶意网页跨站驱动浏览器） */
	r = await jsonPost("/api/browser/cmd", { op: "tabs_list" }, { Origin: "https://evil.example" });
	ok(r.status === 403, "带 Origin 的请求被 403 拒绝");

	/* 5) 命令往返 */
	r = await jsonPost("/api/browser/cmd", { op: "navigate", args: { url: "https://example.com" } });
	j = await r.json();
	ok(j.ok === true && j.tabId === 1 && cmds.length === 1 && cmds[0].op === "navigate", "navigate 命令往返成功");

	/* 6) 截图落盘 */
	r = await jsonPost("/api/browser/cmd", { op: "screenshot" });
	j = await r.json();
	const shotPath = j.path || "";
	ok(j.ok === true && shotPath.includes(".agent-deck/shots/") && existsSync(shotPath), "截图已保存到 ~/.agent-deck/shots/");
	if (shotPath && existsSync(shotPath)) {
		const bytes = readFileSync(shotPath);
		ok(bytes.toString().startsWith("FAKE-PNG"), "落盘内容与插件回传一致");
	}

	/* 7) 插件断线后命令报错 */
	ext.close();
	await wait(500);
	r = await jsonPost("/api/browser/cmd", { op: "tabs_list" });
	j = await r.json();
	ok(j.ok === false && /not connected/i.test(j.error), "插件断线后恢复报错");

	console.log(failures ? `\n${failures} 项失败` : "\n全部通过 🎉");
} catch (err) {
	console.error("测试异常:", err);
	failures++;
} finally {
	rmSync(join(homedir(), ".agent-deck", "shots"), { recursive: true, force: true });
	server.kill();
	process.exit(failures ? 1 : 0);
}
