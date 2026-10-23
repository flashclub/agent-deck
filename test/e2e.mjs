/**
 * AgentDeck 协议级端到端测试（不依赖浏览器）
 *  1. 连接 WS → hello 拿智能体列表
 *  2. spawn shell 窗格 → 输入 echo → 验证输出回传
 *  3. spawn pi 窗格 → 验证 TUI 启动（有输出且未退出）
 *  4. kill 清理
 */
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";

const ws = new WebSocket("ws://127.0.0.1:7788/ws");
const waiters = [];
let shellPane = null, piPane = null, shellOut = "", piOut = "";
let done = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function send(o) { ws.send(JSON.stringify(o)); }

ws.on("message", async (raw) => {
	const m = JSON.parse(raw.toString());
	if (m.t === "hello") {
		console.log("智能体:", m.agents.map((a) => a.name).join(" / "));
		if (!m.agents.length) throw new Error("无可用智能体");
		// 1) shell
		send({ t: "spawn", agentId: "shell", cwd: "/tmp" });
	}
	if (m.t === "panes") {
		for (const p of m.panes) {
			if (p.agentId === "shell" && shellPane === null && p.running) { shellPane = p.id; console.log("shellPane =", p.id); }
			if (p.agentId === "pi" && piPane === null && p.running) piPane = p.id;
		}
	}
	if (m.t === "output") {
		if (m.id === shellPane) shellOut += m.data;
		if (m.id === piPane) piOut += m.data;
	}
});

try {
	if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.once("open", r));
	send({ t: "hello" });
	await wait(1500);

	// shell 已启动，输入命令
	send({ t: "input", id: shellPane, data: "echo AG_GRID_E2E_OK\n" });
	await wait(1500);
	console.log("shell 输出包含标记:", shellOut.includes("AG_GRID_E2E_OK") ? "✅" : "❌ " + JSON.stringify(shellOut.slice(0, 200)));

	// 2) pi
	send({ t: "spawn", agentId: "pi", cwd: REPO_DIR });
	await wait(6000);
	const running = piOut.length > 100;
	console.log("pi TUI 启动:", running ? "✅ (输出 " + piOut.length + " 字符)" : "❌");
	const hasAnsi = /\x1b\[/.test(piOut);
	console.log("ANSI 渲染流:", hasAnsi ? "✅" : "❌");

	// 3) resize 测试
	send({ t: "resize", id: piPane, cols: 120, rows: 40 });
	await wait(500);

	// 4) 清理
	send({ t: "kill", id: piPane });
	send({ t: "kill", id: shellPane });
	await wait(800);
	done = shellOut.includes("AG_GRID_E2E_OK") && running && hasAnsi;
} catch (e) {
	console.error("测试异常:", e.message);
} finally {
	ws.close();
	process.exit(done ? 0 : 1);
}
