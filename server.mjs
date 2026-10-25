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

function spawnPane({ agentId, cwd, slot }) {
	const agent = AGENTS.find((a) => a.id === agentId);
	if (!agent) throw new Error(`Unknown agent: ${agentId}`);
	const absCwd = path.resolve(cwd || lastCwd || os.homedir());
	if (!fs.existsSync(absCwd) || !fs.statSync(absCwd).isDirectory()) {
		throw new Error(`Directory not found: ${absCwd}`);
	}
	lastCwd = absCwd;

	const id = `p${Date.now().toString(36)}${(++paneSeq).toString(36)}`;
	const pane = {
		id, agentId: agent.id, name: agent.name, icon: agent.icon,
		cwd: absCwd, title: `${agent.name} · ${path.basename(absCwd)}`,
		slot: Number.isInteger(slot) && slot >= 0 && slot <= 3 ? slot : null,
		proc: null, buf: [], bufLen: 0, exitCode: null,
		cols: 100, rows: 28, startedAt: Date.now(),
	};

	const proc = pty.spawn(agent.file, agent.args, {
		name: "xterm-256color",
		cols: pane.cols, rows: pane.rows,
		cwd: absCwd,
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
					}));
					scanRecentDirs().then((recents) => {
						if (ws.readyState === 1) ws.send(JSON.stringify({ t: "recents", recents }));
					});
					break;
				case "spawn": {
					const pane = spawnPane({ agentId: m.agentId, cwd: m.cwd, slot: m.slot });
					ws.send(JSON.stringify({ t: "spawned-yours", id: pane.id }));
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
	res.writeHead(404).end("not found");
});

server.on("upgrade", (req, socket, head) => {
	const { pathname } = new URL(req.url, "http://localhost");
	if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
	else socket.destroy();
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
});
