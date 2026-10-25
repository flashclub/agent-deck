#!/usr/bin/env node
/**
 * AgentDeck — 多智能体操作台服务器
 *
 * 一个页面 2×2 四个终端窗格，每个窗格任选智能体（pi / Claude Code / Codex / shell）运行。
 * 原理：node-pty 为每个窗格分配一个伪终端，浏览器用 xterm.js 渲染，WebSocket 双向传输。
 * 仅监听 127.0.0.1，无鉴权，请勿暴露到公网。
 *
 * 启动：node server.mjs [port]
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PORT = Number(process.env.AG_PORT || process.argv[2] || 7788);
const HOST = process.env.AG_HOST || "127.0.0.1";
const PI_SESSIONS_ROOT = path.join(os.homedir(), ".pi/agent/sessions");
const BUF_CAP = 160 * 1024; // 每窗格回放缓冲上限（字符）
/* 最近目录扫描开关：AG_RECENTS=0 可完全关闭（不读取 pi 会话库，零磁盘扫描） */
const ENABLE_RECENTS = process.env.AG_RECENTS !== "0";

/* ------------------------------------------------------------------ */
/* 智能体清单（自动探测本机可用性）                                      */
/* ------------------------------------------------------------------ */

function which(cmd) {
	try {
		return execFileSync("/bin/sh", ["-c", `command -v ${JSON.stringify(cmd)}`], { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function detectAgents() {
	const list = [
		{ id: "pi", name: "Pi", icon: "π", desc: "pi coding agent", file: path.join(os.homedir(), ".pi/agent/bin/pi"), args: [] },
		{ id: "claude", name: "Claude Code", icon: "✳", desc: "claude cli", file: "claude", args: [] },
		{ id: "codex", name: "Codex", icon: "◆", desc: "openai codex cli", file: "codex", args: [] },
		{ id: "gemini", name: "Gemini", icon: "◈", desc: "gemini cli", file: "gemini", args: [] },
		{ id: "aider", name: "Aider", icon: "⌘", desc: "aider ai pair", file: "aider", args: [] },
		{ id: "shell", name: "Shell", icon: ">_", desc: "zsh login shell", file: process.env.SHELL || "/bin/zsh", args: ["-l"] },
	];
	const found = [];
	for (const a of list) {
		let file = a.file;
		if (a.id !== "shell") {
			const resolved = which(a.file) || (fs.existsSync(a.file) ? a.file : "");
			if (!resolved) continue; // 未安装则不显示
			file = resolved;
		}
		found.push({ id: a.id, name: a.name, icon: a.icon, desc: a.desc, file, args: a.args });
	}
	return found;
}
const AGENTS = detectAgents();

/* 子进程 PATH：合并常见安装位置，避免从 Finder/launchd 启动时找不到命令 */
const CHILD_PATH = [
	process.env.PATH,
	"/usr/local/bin",
	"/opt/homebrew/bin",
	path.join(os.homedir(), ".local/bin"),
	path.join(os.homedir(), ".pi/agent/bin"),
].filter(Boolean).join(":");

/* ------------------------------------------------------------------ */
/* 窗格（PTY）管理                                                      */
/* ------------------------------------------------------------------ */

const panes = new Map(); // id -> pane
let paneSeq = 0;
let lastCwd = process.cwd();

function paneMeta(p) {
	return {
		id: p.id, agentId: p.agentId, name: p.name, icon: p.icon,
		cwd: p.cwd, title: p.title, slot: p.slot, running: p.proc !== null,
		exitCode: p.exitCode, startedAt: p.startedAt, cols: p.cols, rows: p.rows,
		wt: p.wt, wtDropped: p.wtDropped,
	};
}

/* 代终端应答 OSC 10/11 颜色查询：pi 等 TUI 靠它探测终端明暗并自适应调色板。
   xterm.js 不应答，浏览器往返又常超过 TUI 的等待窗口（~100ms），
   所以在 PTY 输出流上直接扫描并即时注入应答 */
const TERM_FGBG = {
	dark: { fg: [0xee, 0xf1, 0xf6], bg: [0x21, 0x25, 0x2e] },
	light: { fg: [0x1d, 0x22, 0x2c], bg: [0xff, 0xff, 0xff] },
};
let termTheme = "dark";
const oscColorReply = (which) => {
	const c = which === 11 ? TERM_FGBG[termTheme].bg : TERM_FGBG[termTheme].fg;
	return `\x1b]${which};rgb:${c.map((v) => (v * 257).toString(16).padStart(4, "0")).join("/")}\x07`;
};

function spawnPane({ agentId, cwd, slot, worktree, reuseWt }) {
	const agent = AGENTS.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Unknown agent: ${agentId}`);
	const absCwd = path.resolve(cwd || lastCwd || os.homedir());
	if (!fs.existsSync(absCwd) || !fs.statSync(absCwd).isDirectory()) {
		throw new Error(`Directory not found: ${absCwd}`);
	}
	lastCwd = absCwd;

	/* worktree 隔离：restart 传 reuseWt 复用原工作区，避免每次重启累积新分支 */
	let wt = null, wtDropped = false, ptyCwd = absCwd;
	if (reuseWt && reuseWt.wtPath && fs.existsSync(reuseWt.wtPath)) {
		wt = reuseWt;
		ptyCwd = reuseWt.wtPath;
	} else if (worktree) {
		const created = createWorktree(absCwd);
		if (created) { wt = created; ptyCwd = created.wtPath; }
		else wtDropped = true; /* 非 git 仓库：降级为普通目录 */
	}

	const id = `p${Date.now().toString(36)}${(++paneSeq).toString(36)}`;
	const pane = {
		id, agentId: agent.id, name: agent.name, icon: agent.icon,
		cwd: absCwd, wt, wtDropped, title: `${agent.name} · ${path.basename(absCwd)}`,
		slot: Number.isInteger(slot) && slot >= 0 && slot <= 3 ? slot : null,
		proc: null, buf: [], bufLen: 0, exitCode: null,
		cols: 100, rows: 28, startedAt: Date.now(),
	};

	const proc = pty.spawn(agent.file, agent.args, {
		name: "xterm-256color",
		cols: pane.cols, rows: pane.rows,
		cwd: ptyCwd,
		env: { ...process.env, PATH: CHILD_PATH, TERM: "xterm-256color", COLORTERM: "truecolor" },
	});
	pane.proc = proc;

	proc.onData((data) => {
		if (Date.now() - pane.startedAt < 8000) {
			/* 启动窗口内扫描颜色查询；扫描全块，尾巴 12 字符防序列跨块 */
			const hay = (pane.scanTail || "") + data;
			let replied = false;
			for (const which of [10, 11]) {
				if (hay.includes(`]${which};?`)) {
					/* pi 会查询两轮（首轮应答可能被丢弃），每次真实出现都应答 */
					try { proc.write(oscColorReply(which)); replied = true; } catch {}
				}
			}
			pane.scanTail = replied ? "" : hay.slice(-12);
		}
		pane.buf.push(data);
		pane.bufLen += data.length;
		while (pane.bufLen > BUF_CAP && pane.buf.length > 1) {
			pane.bufLen -= pane.buf[0].length;
			pane.buf.shift();
		}
		broadcast({ t: "output", id: pane.id, data });
	});
	proc.onExit(({ exitCode }) => {
		pane.proc = null;
		pane.exitCode = exitCode;
		broadcast({ t: "exit", id: pane.id, code: exitCode });
		broadcast({ t: "panes", panes: [...panes.values()].map(paneMeta) });
	});

	panes.set(id, pane);
	broadcast({ t: "spawned", pane: paneMeta(pane) });
	broadcast({ t: "panes", panes: [...panes.values()].map(paneMeta) });
	return paneMeta(pane);
}

function killPane(id) {
	const p = panes.get(id);
	if (!p) return;
	if (p.proc) {
		try { p.proc.kill(); } catch {}
		// 3 秒后仍未退出则强杀
		setTimeout(() => { if (p.proc) { try { p.proc.kill("SIGKILL"); } catch {} } }, 3000);
	}
	panes.delete(id);
	broadcast({ t: "panes", panes: [...panes.values()].map(paneMeta) });
}

/* ------------------------------------------------------------------ */
/* git worktree 隔离：窗格可跑在仓库外的独立工作区                         */
/* ------------------------------------------------------------------ */

const WT_ROOT = path.join(os.homedir(), ".agent-deck", "worktrees");

function gitRun(args, cwd) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitRoot(dir) {
	try { return gitRun(["rev-parse", "--show-toplevel"], dir); } catch { return ""; }
}

/* 为 cwd 创建独立 worktree：仓库外建目录 + 从当前 HEAD 切分支。
   返回 null = 不是 git 仓库（调用方降级为普通目录）；throw = git 失败（如空仓库） */
function createWorktree(cwd) {
	const root = gitRoot(cwd);
	if (!root) return null;
	const id = `wt${Date.now().toString(36)}`;
	const slug = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
	const hash = crypto.createHash("sha1").update(root).digest("hex").slice(0, 8);
	const wtPath = path.join(WT_ROOT, `${slug}-${hash}`, id);
	const branch = `ad/${id}`;
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });
	gitRun(["worktree", "add", "-b", branch, wtPath], root);
	return { repoRoot: root, wtPath, branch };
}

/* 处置 worktree：merge（自动提交后合并回主工作区当前分支）/ discard / keep */
function disposeWorktree(pane, action) {
	const wt = pane.wt;
	if (!wt) return { ok: false, error: "no worktree" };
	const { repoRoot, wtPath, branch } = wt;
	const failMsg = (err) => String((err && (err.stderr || err.stdout)) || err?.message || err || "").trim().slice(0, 400);
	if (action === "merge") {
		try {
			if (gitRun(["status", "--porcelain"], wtPath)) {
				gitRun(["add", "-A"], wtPath);
				gitRun(["commit", "-m", `AgentDeck: ${pane.agentId} snapshot (${branch})`], wtPath);
			}
			gitRun(["merge", branch, "--no-edit"], repoRoot);
		} catch (err) {
			return { ok: false, conflict: true, error: failMsg(err) };
		}
		/* 合并已成功，清理失败不回滚，只报告 */
		let cleanup = "";
		try { gitRun(["worktree", "remove", "--force", wtPath], repoRoot); } catch (err) { cleanup = failMsg(err); }
		try { gitRun(["branch", "-D", branch], repoRoot); } catch (err) { cleanup += " " + failMsg(err); }
		return { ok: true, merged: true, cleanup: cleanup.trim() };
	}
	if (action === "discard") {
		try { gitRun(["worktree", "remove", "--force", wtPath], repoRoot); } catch {}
		try { gitRun(["branch", "-D", branch], repoRoot); } catch {}
		return { ok: true, discarded: true };
	}
	return { ok: true, kept: wtPath }; /* keep：保留工作区，仅关进程 */
}

/* ------------------------------------------------------------------ */
/* 最近目录（来自 pi 会话库，方便快速选 cwd）                             */
/* ------------------------------------------------------------------ */

async function scanRecentDirs() {
	if (!ENABLE_RECENTS) return [];
	const cwds = new Map(); // cwd -> latest mtime
	let dirs;
	try { dirs = await fsp.readdir(PI_SESSIONS_ROOT, { withFileTypes: true }); } catch { return []; }
	for (const d of dirs.slice(0, 80)) {
		if (!d.isDirectory()) continue;
		const dirPath = path.join(PI_SESSIONS_ROOT, d.name);
		let files;
		try { files = await fsp.readdir(dirPath); } catch { continue; }
		let latest = 0, cwd = null;
		for (const f of files.filter((x) => x.endsWith(".jsonl")).slice(-30)) {
			try {
				const st = await fsp.stat(path.join(dirPath, f));
				if (st.mtimeMs > latest) {
					latest = st.mtimeMs;
					// 只读第一行会话头拿 cwd
					const fh = await fsp.open(path.join(dirPath, f), "r");
					const { buffer, bytesRead } = await fh.read(Buffer.alloc(4096), 0, 4096, 0);
					await fh.close();
					const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
					const head = JSON.parse(first);
					if (head?.cwd) cwd = head.cwd;
				}
			} catch {}
		}
		if (cwd) cwds.set(cwd, Math.max(latest, cwds.get(cwd) || 0));
	}
	return [...cwds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cwd]) => cwd);
}

/* ------------------------------------------------------------------ */
/* 浏览器插件桥接：插件经 /ext 反连，agent 经 HTTP API 下发命令            */
/* ------------------------------------------------------------------ */

const SHOTS_DIR = path.join(os.homedir(), ".agent-deck", "shots");
const extClients = new Set();
const pendingBrowser = new Map(); // id -> { resolve, reject, timer }
let browserSeq = 0;

/* 配对 token：优先 AG_EXT_TOKEN；否则持久化到 ~/.agent-deck/ext-token（重启不变，免重复配对） */
const EXT_TOKEN = (() => {
	if (process.env.AG_EXT_TOKEN) return process.env.AG_EXT_TOKEN;
	const f = path.join(os.homedir(), ".agent-deck", "ext-token");
	try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t; } catch {}
	const t = crypto.randomBytes(24).toString("base64url");
	try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t, { mode: 0o600 }); } catch {}
	return t;
})();

function readBody(req, limit = 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/* 下发一条浏览器命令给已配对的插件，等 cmd-result 回包（15s 超时） */
function browserCommand({ op, args = {} }) {
	if (!op || typeof op !== "string") return Promise.reject(new Error("missing op"));
	if (!extClients.size) return Promise.reject(new Error("extension not connected (open the AgentDeck extension and pair first)"));
	const id = `b${Date.now().toString(36)}${(++browserSeq).toString(36)}`;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pendingBrowser.delete(id);
			reject(new Error("extension timeout (15s)"));
		}, 15000);
		pendingBrowser.set(id, { resolve, reject, timer });
		const msg = JSON.stringify({ t: "cmd", id, op, args });
		for (const ws of extClients) {
			if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
		}
	});
}

const extWss = new WebSocketServer({ noServer: true });

/* 未授权的插件连接可以存在，但只能收 pair-request / 发 pair-approve；拿到 token 才升级为完全控制 */
const pendingPairs = new Map(); // nonce -> timer

function pairRequest() {
	const nonce = crypto.randomBytes(16).toString("hex");
	pendingPairs.set(nonce, setTimeout(() => pendingPairs.delete(nonce), 2 * 60 * 1000));
	const msg = JSON.stringify({ t: "pair-request", nonce });
	for (const ws of extWss.clients) {
		if (ws.readyState === 1 && !ws._adAuthed) { try { ws.send(msg); } catch {} }
	}
	return nonce;
}

function broadcastBrowserStatus() {
	broadcast({ t: "browser-status", connected: extClients.size > 0 });
}

extWss.on("connection", (ws) => {
	let authed = false;
	ws._adAuthed = false;
	ws.on("message", (raw) => {
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		if (!authed) {
			/* 握手：token 正确 → 完全控制；否则留在待配对状态（不再直接踢，支持一键配对流程） */
			if (m.t === "ext-hello") {
				if (m.token === EXT_TOKEN) {
					authed = true; ws._adAuthed = true; extClients.add(ws);
					try { ws.send(JSON.stringify({ t: "ext-hello-ok" })); } catch {}
					broadcastBrowserStatus();
				} else {
					try { ws.send(JSON.stringify({ t: "pair-needed" })); } catch {}
				}
				return;
			}
			/* 配对同意：UI 点「连接浏览器」→ 服务端推 pair-request(nonce) → 用户在扩展弹窗点同意 */
			if (m.t === "pair-approve" && typeof m.nonce === "string" && pendingPairs.has(m.nonce)) {
				clearTimeout(pendingPairs.get(m.nonce));
				pendingPairs.delete(m.nonce);
				authed = true; ws._adAuthed = true; extClients.add(ws);
				try { ws.send(JSON.stringify({ t: "pair-ok", token: EXT_TOKEN })); } catch {}
				broadcastBrowserStatus();
			}
			if (m.t === "pair-deny" && typeof m.nonce === "string") {
				clearTimeout(pendingPairs.get(m.nonce));
				pendingPairs.delete(m.nonce);
			}
			/* pair-deny / 其他消息：一律忽略 */
			return;
		}
		switch (m.t) {
			case "ping":
				try { ws.send(JSON.stringify({ t: "pong" })); } catch {}
				break;
			case "cmd-result": {
				const p = pendingBrowser.get(m.id);
				if (!p) break;
				pendingBrowser.delete(m.id);
				clearTimeout(p.timer);
				if (m.ok) p.resolve(m.data);
				else p.reject(new Error(String(m.error || "extension error")));
				break;
			}
		}
	});
	ws.on("close", () => { extClients.delete(ws); broadcastBrowserStatus(); });
	ws.on("error", () => {});
});

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true });

function broadcast(obj) {
	const msg = JSON.stringify(obj);
	for (const ws of wss.clients) {
		if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
	}
}

wss.on("connection", (ws) => {
	ws.on("message", (raw) => {
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		try {
			switch (m.t) {
				case "hello":
					ws.send(JSON.stringify({
						t: "hello",
						agents: AGENTS,
						recents: undefined, // 占位，下面异步补
						panes: [...panes.values()].map(paneMeta),
						browser: extClients.size > 0,
					}));
					scanRecentDirs().then((recents) => {
						if (ws.readyState === 1) ws.send(JSON.stringify({ t: "recents", recents }));
					});
					break;
				case "spawn": {
					const pane = spawnPane({ agentId: m.agentId, cwd: m.cwd, slot: m.slot, worktree: !!m.worktree, reuseWt: m.reuseWt });
					ws.send(JSON.stringify({ t: "spawned-yours", id: pane.id }));
					if (panes.get(pane.id)?.wtDropped) {
						ws.send(JSON.stringify({ t: "notice", code: "wt-dropped" }));
					}
					break;
				}
				case "wt-dispose": {
					/* 杀进程 + 处置 worktree 一体完成（killPane 会立刻删记录，这里单独处理） */
					const p = panes.get(m.id);
					if (!p) {
						ws.send(JSON.stringify({ t: "wt-disposed", id: m.id, branch: "", result: { ok: false, error: "pane not found" } }));
						break;
					}
					const action = m.action === "merge" || m.action === "discard" ? m.action : "keep";
					if (p.proc) {
						try { p.proc.kill(); } catch {}
						setTimeout(() => { try { p.proc.kill("SIGKILL"); } catch {} }, 1500);
					}
					const result = disposeWorktree(p, action);
					const branch = p.wt ? p.wt.branch : "";
					panes.delete(m.id);
					broadcast({ t: "panes", panes: [...panes.values()].map(paneMeta) });
					if (ws.readyState === 1) ws.send(JSON.stringify({ t: "wt-disposed", id: m.id, branch, result }));
					break;
				}
				case "setTitle": {
					const p = panes.get(m.id);
					if (p) {
						const title = String(m.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
						if (title) {
							p.title = title;
							broadcast({ t: "panes", panes: [...panes.values()].map(paneMeta) });
						}
					}
					break;
				}
				case "input": {
					const p = panes.get(m.id);
					if (p?.proc) {
						let data = m.data;
						/* xterm.js 用 VT100 应答 DA1（ESC[?1;2c），TUI（如 pi）会据此判定
						   终端不支持 OSC 颜色查询而丢弃我们的 OSC 10/11 应答；
						   启动窗口内丢弃该应答，让 TUI 走无 DA1 的回退探测（实测颜色协商正常） */
						if (Date.now() - p.startedAt < 8000 && data.includes("\x1b[?")) {
							data = data.replace(/\x1b\[\?[0-9;]*c/g, "");
						}
						p.proc.write(data);
					}
					break;
				}
				case "resize": {
					const p = panes.get(m.id);
					if (p?.proc && m.cols >= 2 && m.rows >= 2) {
						p.cols = m.cols; p.rows = m.rows;
						try { p.proc.resize(m.cols, m.rows); } catch {}
					}
					break;
				}
				case "replay": {
					const p = panes.get(m.id);
					if (p && ws.readyState === 1) ws.send(JSON.stringify({ t: "output", id: p.id, data: p.buf.join("") }));
					break;
				}
				case "termTheme":
					if (m.theme === "light" || m.theme === "dark") termTheme = m.theme;
					break;
				case "kill": killPane(m.id); break;
			}
		} catch (err) {
			try { ws.send(JSON.stringify({ t: "error", message: String(err?.message || err) })); } catch {}
		}
	});
});

/* ------------------------------------------------------------------ */
/* HTTP：静态资源                                                       */
/* ------------------------------------------------------------------ */

const MIME = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

const STATIC = {
	"/": path.join(__dirname, "public", "index.html"),
	"/vendor/normalize.css": path.join(__dirname, "node_modules", "modern-normalize", "modern-normalize.css"),
	"/vendor/xterm.js": path.join(__dirname, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
	"/vendor/xterm.css": path.join(__dirname, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
	"/vendor/addon-fit.js": path.join(__dirname, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
};

const server = http.createServer(async (req, res) => {
	const p = new URL(req.url, "http://localhost").pathname;
	const file = STATIC[p];
	if (req.method === "GET" && file) {
		try {
			const data = await fsp.readFile(file);
			res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
			return res.end(data);
		} catch {
			/* fallthrough */
		}
	}
	if (req.method === "GET" && p === "/api/recents") {
		return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ recents: await scanRecentDirs() }));
	}
	if (req.method === "GET" && p === "/api/browser/status") {
		return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ connected: extClients.size > 0 }));
	}
	if (req.method === "POST" && p === "/api/browser/pair") {
		/* 只允许自家 UI 页面（Origin === 本服务地址）或无 Origin 的本地进程（curl）；其他来源一律拒绝 */
		const origin = String(req.headers.origin || "");
		const ownOrigin = origin === "" || origin === `http://${req.headers.host || ""}`;
		if (!ownOrigin) return res.writeHead(403).end("forbidden");
		if (!extWss.clients.size) {
			return res.writeHead(400, { "Content-Type": "application/json" })
				.end(JSON.stringify({ ok: false, error: "extension not connected — install/enable the AgentDeck Bridge extension first" }));
		}
		if (extClients.size) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, already: true }));
		pairRequest();
		return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
	}
	if (req.method === "POST" && p === "/api/browser/cmd") {
		/* 拒带 Origin 的请求：浏览器里的恶意网页无法跨站驱动本机浏览器（curl/agent 不带 Origin） */
		if (req.headers.origin) return res.writeHead(403).end("forbidden");
		try {
			const body = JSON.parse((await readBody(req)) || "{}");
			const data = await browserCommand(body);
			if (body.op === "screenshot" && data?.pngBase64) {
				fs.mkdirSync(SHOTS_DIR, { recursive: true });
				const file = path.join(SHOTS_DIR, `shot-${Date.now()}.png`);
				fs.writeFileSync(file, Buffer.from(data.pngBase64, "base64"));
				const payload = { ok: true, path: file, bytes: fs.statSync(file).size, url: data.url, title: data.title };
				/* inline: MCP 等调用方要内联图片；curl 默认不给，避免终端唰屏 */
				if (body.inline) payload.pngBase64 = data.pngBase64;
				return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
			}
			return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, ...(data || {}) }));
		} catch (err) {
			return res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
		}
	}
	res.writeHead(404).end("not found");
});

server.on("upgrade", (req, socket, head) => {
	const { pathname } = new URL(req.url, "http://localhost");
	if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	else if (pathname === "/ext") {
		/* 关键防线：浏览器里的恶意网页也能连 ws://127.0.0.1，但它的 Origin 是 https://…；
		   真实扩展的 SW 连接 Origin 是 chrome-extension://，本地进程/测试客户端无 Origin。
		   网页来源一律拒绝，防抢答配对、防未授权驱动浏览器 */
		const origin = String(req.headers.origin || "");
		if (/^https?:\/\//i.test(origin)) { socket.destroy(); return; }
		extWss.handleUpgrade(req, socket, head, (ws) => extWss.emit("connection", ws, req));
	} else socket.destroy();
});

/* 优雅退出 */
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		for (const p of panes.values()) {
			if (p.proc) { try { p.proc.kill(); } catch {} }
		}
		setTimeout(() => process.exit(0), 500).unref();
		process.exit(0);
	});
}

server.listen(PORT, HOST, () => {
	console.log(`AgentDeck`);
	console.log(`  URL:     http://${HOST}:${PORT}`);
	console.log(`  Agents:  ${AGENTS.map((a) => a.name).join(" / ")}`);
	console.log(`  Browser: pair the extension (extension/) — token in ~/.agent-deck/ext-token`);
});
