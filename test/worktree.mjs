/**
 * Worktree 功能端到端测试（协议级，自起服务，不需要浏览器）
 * 覆盖：创建 → 提交并合并 → 丢弃 → 保留 → 非 git 目录降级 → restart 复用
 * 运行：node test/worktree.mjs
 */
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = dirname(fileURLToPath(import.meta.url)) + "/..";
const PORT = 7799;

let failures = 0;
const ok = (cond, label) => {
	console.log((cond ? "✅" : "❌") + " " + label);
	if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });

/* ---------- 起服务 ---------- */
const server = spawn(process.execPath, [join(REPO_DIR, "server.mjs"), String(PORT)], {
	cwd: REPO_DIR,
	env: { ...process.env, AG_RECENTS: "0" },
	stdio: "ignore",
});
await wait(1200);

/* ---------- 临时仓库 ---------- */
const tmpRepo = mkdtempSync(join(tmpdir(), "ad-wt-repo-"));
git(["init", "-q"], tmpRepo);
git(["config", "user.email", "test@local"], tmpRepo);
git(["config", "user.name", "test"], tmpRepo);
writeFileSync(join(tmpRepo, "base.txt"), "base\n");
git(["add", "-A"], tmpRepo);
git(["commit", "-q", "-m", "init"], tmpRepo);
const plainDir = mkdtempSync(join(tmpdir(), "ad-wt-plain-"));

const cleanup = () => {
	try { rmSync(tmpRepo, { recursive: true, force: true }); } catch {}
	try { rmSync(plainDir, { recursive: true, force: true }); } catch {}
	try { rmSync(join(process.env.HOME || "", ".agent-deck/worktrees"), { recursive: true, force: true }); } catch {}
	server.kill();
};

/* ---------- WS 客户端 ---------- */
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let panes = [];
const outputs = new Map();
let disposed = null;
ws.on("message", (raw) => {
	const m = JSON.parse(raw.toString());
	if (m.t === "panes") panes = m.panes;
	if (m.t === "output") outputs.set(m.id, (outputs.get(m.id) || "") + m.data);
	if (m.t === "wt-disposed") disposed = m;
});
const send = (o) => ws.send(JSON.stringify(o));

async function spawnWt(cwd, extra = {}) {
	disposed = null;
	const before = new Set(panes.map((p) => p.id));
	send({ t: "spawn", agentId: "shell", cwd, worktree: true, ...extra });
	for (let i = 0; i < 50; i++) {
		await wait(100);
		const p = panes.find((x) => x.running && !before.has(x.id));
		if (p) return p;
	}
	throw new Error("spawn timeout");
}
const waitGone = async (id) => {
	for (let i = 0; i < 30; i++) {
		await wait(100);
		if (!panes.some((p) => p.id === id)) return true;
	}
	return false;
};

try {
	if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.once("open", r));
	send({ t: "hello" });
	await wait(500);

	/* 1) 创建 worktree */
	const p1 = await spawnWt(tmpRepo);
	const wt1 = panes.find((x) => x.id === p1.id)?.wt;
	ok(!!wt1 && wt1.branch.startsWith("ad/wt"), "spawn 创建了 ad/wt* 分支的 worktree");
	ok(existsSync(wt1.wtPath), "worktree 目录存在: " + wt1.wtPath);

	/* 2) 在 worktree 里改文件并提交 → 合并回主分支 */
	send({ t: "input", id: p1.id, data: "echo changed > base.txt && echo new > extra.txt\r" });
	await wait(1000);
	send({ t: "wt-dispose", id: p1.id, action: "merge" });
	for (let i = 0; i < 30 && !disposed; i++) await wait(100);
	ok(disposed?.result?.merged === true, "merge 处置成功");
	ok(await waitGone(p1.id), "窗格已移除");
	ok(existsSync(join(tmpRepo, "extra.txt")), "改动已合并回主仓库（extra.txt 存在）");
	ok(git(["ls-files"], tmpRepo).includes("extra.txt"), "改动已入库（extra.txt 被 git 跟踪）");
	ok(git(["log", "--oneline", "-1"], tmpRepo).includes("AgentDeck:"), "快照提交已合并进主分支");
	const branches = git(["branch", "--list", "ad/*"], tmpRepo);
	ok(!branches.trim(), "分支已清理");
	ok(!existsSync(wt1.wtPath), "worktree 目录已移除");

	/* 3) discard：改动全丢 */
	const p2 = await spawnWt(tmpRepo);
	const wt2 = panes.find((x) => x.id === p2.id)?.wt;
	send({ t: "input", id: p2.id, data: "echo junk > junk.txt\r" });
	await wait(1000);
	send({ t: "wt-dispose", id: p2.id, action: "discard" });
	for (let i = 0; i < 30 && !disposed; i++) await wait(100);
	ok(disposed?.result?.discarded === true, "discard 处置成功");
	ok(!existsSync(join(wt2.wtPath, "junk.txt")) && !existsSync(wt2.wtPath), "worktree 目录及改动已丢弃");
	ok(!git(["branch", "--list", "ad/*"], tmpRepo).trim(), "discard 后分支已清理");

	/* 4) keep：只关进程，工作区保留 */
	const p3 = await spawnWt(tmpRepo);
	const wt3 = panes.find((x) => x.id === p3.id)?.wt;
	send({ t: "wt-dispose", id: p3.id, action: "keep" });
	for (let i = 0; i < 30 && !disposed; i++) await wait(100);
	ok(disposed?.result?.kept === wt3.wtPath, "keep 处置成功");
	ok(existsSync(wt3.wtPath), "keep 后 worktree 仍在磁盘");
	ok(git(["branch", "--list", "ad/*"], tmpRepo).trim().length > 0, "keep 后分支仍在");

	/* 5) restart 复用同一 worktree（不新建分支） */
	send({ t: "spawn", agentId: "shell", cwd: tmpRepo, reuseWt: wt3 });
	let p4 = null;
	for (let i = 0; i < 50; i++) {
		await wait(100);
		p4 = panes.find((x) => x.running && x.wt?.wtPath === wt3.wtPath);
		if (p4) break;
	}
	ok(!!p4, "restart 复用原 worktree（同路径）");
	const branchCount = git(["branch", "--list", "ad/*"], tmpRepo).trim().split("\n").filter(Boolean).length;
	ok(branchCount === 1, "restart 未产生新分支（共 " + branchCount + " 个 ad/*）");
	send({ t: "wt-dispose", id: p4.id, action: "discard" });
	for (let i = 0; i < 30 && !disposed; i++) await wait(100);

	/* 6) 非 git 目录：降级普通目录 */
	const p5 = await spawnWt(plainDir);
	const meta5 = panes.find((x) => x.id === p5.id);
	ok(!meta5?.wt && meta5?.wtDropped === true, "非 git 目录降级为普通目录（wtDropped）");
	send({ t: "kill", id: p5.id });
	await waitGone(p5.id);

	/* 7) 输出确实来自 worktree（pwd 验证） */
	const p6 = await spawnWt(tmpRepo);
	send({ t: "input", id: p6.id, data: "pwd\r" });
	await wait(1200);
	const out = outputs.get(p6.id) || "";
	ok(out.includes(".agent-deck/worktrees"), "PTY 实际运行在 worktree 路径下");
	send({ t: "wt-dispose", id: p6.id, action: "discard" });
	for (let i = 0; i < 30 && !disposed; i++) await wait(100);

	console.log(failures ? `\n${failures} 项失败` : "\n全部通过 🎉");
} catch (err) {
	console.error("测试异常:", err);
	failures++;
} finally {
	cleanup();
	process.exit(failures ? 1 : 0);
}
