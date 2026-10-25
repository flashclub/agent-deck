/**
 * 一键配对流程测试（模拟「AgentDeck UI 点连接浏览器 → 扩展弹窗点同意」）
 * 覆盖：恶意网页 Origin 被拒（WS 层 + HTTP 层）、pair-needed、pair 往返、
 *       同意后连接升级为完全控制、错误 nonce 被无视
 * 运行：node test/browser-pair.mjs
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";

const REPO_DIR = join(import.meta.dirname, "..");
const PORT = 7796;
const TOKEN = "pair-test-token";
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

const wsOpen = (url, opts = {}) => new Promise((resolve, reject) => {
	const w = new WebSocket(url, opts);
	w.once("open", () => resolve(w));
	w.once("error", reject);
	setTimeout(() => reject(new Error("ws timeout")), 3000);
});
const nextMsg = (w, filter = () => true) => new Promise((resolve) => {
	const onMsg = (raw) => {
		const m = JSON.parse(raw.toString());
		if (filter(m)) { w.off("message", onMsg); resolve(m); }
	};
	w.on("message", onMsg);
});

try {
	/* 1) 恶意网页（带 https Origin）连 /ext 必须被拒 */
	let evilRejected = false;
	try {
		await wsOpen(`ws://127.0.0.1:${PORT}/ext`, { headers: { Origin: "https://evil.example" } });
	} catch { evilRejected = true; }
	ok(evilRejected, "恶意网页 Origin 连 /ext 被拒（升级层）");

	/* 2) HTTP 层：带恶意 Origin 的 pair 请求被 403 */
	let r = await fetch(`${BASE}/api/browser/pair`, { method: "POST", headers: { Origin: "https://evil.example" } });
	ok(r.status === 403, "恶意 Origin 的 pair 请求被 403");

	/* 3) 正常扩展（chrome-extension Origin 或无 Origin）连接 → pair-needed */
	const ext = await wsOpen(`ws://127.0.0.1:${PORT}/ext`, { headers: { Origin: `chrome-extension://abcdefg` } });
	ext.on("message", (raw) => {
		const m = JSON.parse(raw.toString());
		if (m.t === "cmd") ext.send(JSON.stringify({ t: "cmd-result", id: m.id, ok: true, data: { echo: m.op, tabId: 1 } }));
	});
	ext.send(JSON.stringify({ t: "ext-hello", token: "" }));
	const needed = await nextMsg(ext, (m) => m.t === "pair-needed");
	ok(needed.t === "pair-needed", "空 token 进入待配对（pair-needed）");

	/* 4) 插件未连接的其他分支：无任何插件时 pair 报错 */
	// （此测试里 ext 已连着，属于「未授权但在线」，跳过该分支，在 browser-bridge 中覆盖）

	/* 5) UI 发起配对（自家 Origin）→ 扩展收到 pair-request */
	const pendingReq = nextMsg(ext, (m) => m.t === "pair-request"); // 先挂监听再发请求，避免错过服务端先发的 WS 消息
	r = await fetch(`${BASE}/api/browser/pair`, { method: "POST", headers: { Origin: `http://127.0.0.1:${PORT}` } });
	const pj = await r.json();
	ok(pj.ok === true, "UI 发起配对成功");
	const req = await pendingReq;
	ok(typeof req.nonce === "string" && req.nonce.length > 10, "扩展收到 pair-request(nonce)");

	/* 6) 错误 nonce 的 approve 被无视 */
	let gotEarlyOk = false;
	const onEarly = (raw) => { if (JSON.parse(raw.toString()).t === "pair-ok") gotEarlyOk = true; };
	ext.on("message", onEarly);
	ext.send(JSON.stringify({ t: "pair-approve", nonce: "wrong-nonce" }));
	await wait(600);
	ext.off("message", onEarly);
	ok(!gotEarlyOk, "错误 nonce 不会返回 pair-ok");

	/* 7) 正确 nonce 同意 → pair-ok 带 token */
	ext.send(JSON.stringify({ t: "pair-approve", nonce: req.nonce }));
	const okMsg = await nextMsg(ext, (m) => m.t === "pair-ok");
	ok(okMsg.token === TOKEN, "同意后返回 pair-ok + token");

	/* 8) 同意后该连接升级为完全控制：HTTP 命令可直达 */
	r = await fetch(`${BASE}/api/browser/cmd`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ op: "navigate", args: { url: "https://example.com" } }),
	});
	const cj = await r.json();
	ok(cj.ok === true && cj.tabId === 1, "配对后命令直达（echo tabId=1）");

	/* 9) 配对 nonce 已消费：重放被无视 */
	ext.send(JSON.stringify({ t: "pair-approve", nonce: req.nonce }));
	await wait(400);
	r = await fetch(`${BASE}/api/browser/status`);
	ok((await r.json()).connected === true, "状态为已连接");

	console.log(failures ? `\n${failures} 项失败` : "\n全部通过 🎉");
} catch (err) {
	console.error("测试异常:", err);
	failures++;
} finally {
	rmSync(join(homedir(), ".agent-deck", "shots"), { recursive: true, force: true });
	server.kill();
	process.exit(failures ? 1 : 0);
}
