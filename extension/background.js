/**
 * AgentDeck Bridge — background service worker
 *
 * 与本机 AgentDeck 服务（ws://127.0.0.1:7788/ext）保持一条 token 配对的 WebSocket，
 * 接收 { t:"cmd", op, args } 命令，用 chrome.debugger（CDP）操作浏览器后回包。
 *
 * Chrome 116+ 的 SW 在 WebSocket 活跃期间不会休眠：这里每 20s 发一次 ping 保持双端活性；
 * 断线后 3s 重连，另有 alarms 看门狗兜底。
 */

const SERVER_URL = "ws://127.0.0.1:7788/ext";
const PING_MS = 20000;
const RECONNECT_MS = 3000;

let ws = null;
let tokenCache = null; // 复用内存里的 token，storage 只读一次
let agentTabId = null; // agent 当前工作标签
let agentWinId = null; // 专属窗口：agent 的一切活动都关在这个窗口里（调试横幅也只出现在这里）
let agentGroupId = null; // 专属窗口内的标签组「AgentDeck」
let reconnectTimer = null;
let pingTimer = null;
let consentWinId = null;
let pendingPairNonce = null;

const send = (obj) => { if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } };
const setWsState = (s) => chrome.storage.local.set({ wsState: s });

async function getToken() {
	if (tokenCache) return tokenCache;
	tokenCache = (await chrome.storage.local.get("token")).token || "";
	return tokenCache;
}

function scheduleReconnect() {
	if (reconnectTimer) return;
	reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

function startPing() {
	stopPing();
	pingTimer = setInterval(() => send({ t: "ping" }), PING_MS); // 保活 SW + WS
}
function stopPing() { if (pingTimer) { clearInterval(pingTimer); pingTimer = null; } }

function connect() {
	if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
	getToken().then((token) => {
		try { ws = new WebSocket(SERVER_URL); } catch { setWsState("disconnected"); scheduleReconnect(); return; }
		ws.onopen = () => { ws.send(JSON.stringify({ t: "ext-hello", token: token || "" })); };
		ws.onmessage = (ev) => {
			let m; try { m = JSON.parse(ev.data); } catch { return; }
			if (m.t === "ext-hello-ok") { setWsState("connected"); startPing(); }
			else if (m.t === "pair-needed") setWsState("awaiting-pair");
			else if (m.t === "pair-request") openConsent(m.nonce);
			else if (m.t === "pair-ok") onPaired(m.token);
			else if (m.t === "cmd") handleCmd(m);
		};
		ws.onclose = () => {
			stopPing();
			getToken().then((t) => setWsState(t ? "disconnected" : "no-token"));
			scheduleReconnect();
		};
		ws.onerror = () => {};
	});
}

/* ---------------- 一键配对：UI 点「连接浏览器」→ 服务端推 pair-request → 弹确认窗 ---------------- */

function openConsent(nonce) {
	pendingPairNonce = nonce;
	if (consentWinId != null) return; // 确认窗已开着，复用
	chrome.windows.create({
		url: chrome.runtime.getURL(`consent.html?nonce=${encodeURIComponent(nonce)}`),
		type: "popup", width: 440, height: 260,
	}, (win) => { consentWinId = win?.id ?? null; });
}
chrome.windows.onRemoved.addListener((id) => { if (id === consentWinId) { consentWinId = null; pendingPairNonce = null; } });

function onPaired(token) {
	tokenCache = token || "";
	chrome.storage.local.set({ token: tokenCache });
	setWsState("connected");
	startPing();
	if (consentWinId != null) { try { chrome.windows.remove(consentWinId); } catch {} consentWinId = null; }
}

/* ---------------- 命令实现（chrome.debugger / CDP） ---------------- */

async function cdp(tabId, method, params) {
	return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}

async function attach(tabId) {
	try {
		await chrome.debugger.attach({ tabId }, "1.3");
	} catch (e) {
		if (!/already attached/i.test(String(e?.message || e))) throw e;
	}
}

/* CDP 会弹窗口级「已开始调试」横幅：只有非它不可的操作（eval_js 主世界/绕 CSP、
   screenshot 后台截屏）才用，且用完立即 detach，把横幅压缩到操作瞬间的闪烁 */
async function withCdp(tabId, fn) {
	await attach(tabId);
	try { return await fn(tabId); } finally { try { await chrome.debugger.detach({ tabId }); } catch {} }
}

/* Codex 式隔离：agent 拥有专属窗口（窗口内再设专属标签组「AgentDeck」）。
   调试横幅是窗口级的——只有把任务关在独立窗口里，用户自己的窗口才永远看不到横幅 */
async function ensureGroup() {
	/* 1) 校验/重建专属窗口 */
	if (agentWinId != null) {
		try { await chrome.windows.get(agentWinId); } catch {
			agentWinId = null; agentGroupId = null; agentTabId = null; // 窗口被用户关了
		}
	}
	if (agentWinId == null) {
		const win = await chrome.windows.create({ url: "about:blank", focused: false }); // 不抢焦点
		agentWinId = win.id;
		const blank = win.tabs?.[0];
		if (blank) {
			/* 直接把窗口自带的空白标签变成组内工作标签，避免多一个垃圾标签 */
			agentGroupId = await chrome.tabs.group({ tabIds: [blank.id] });
			try { await chrome.tabGroups.update(agentGroupId, { title: "AgentDeck", color: "purple" }); } catch {}
			agentTabId = blank.id;
		}
		return agentGroupId;
	}
	/* 2) 窗口活着：校验/重建组（组被解散，或被拖去了别的窗口） */
	if (agentGroupId != null) {
		try {
			const g = await chrome.tabGroups.get(agentGroupId);
			if (g.windowId === agentWinId) return agentGroupId;
		} catch {}
		agentGroupId = null;
	}
	agentGroupId = await chrome.tabs.group({ createProperties: { windowId: agentWinId } });
	try { await chrome.tabGroups.update(agentGroupId, { title: "AgentDeck", color: "purple" }); } catch {}
	return agentGroupId;
}

async function ensureTab(preferred) {
	if (preferred != null) return preferred;
	const gid = await ensureGroup();
	if (agentTabId != null) {
		try {
			const t = await chrome.tabs.get(agentTabId);
			if (t && !t.discarded && t.groupId === gid) return agentTabId;
		} catch {}
		agentTabId = null; // 工作标签被关闭，在组里开新的
	}
	const nt = await chrome.tabs.create({ active: false, windowId: agentWinId });
	await chrome.tabs.group({ tabIds: [nt.id], groupId: gid });
	agentTabId = nt.id;
	return nt.id;
}


async function opNavigate(args) {
	if (!args.url) throw new Error("navigate requires args.url");
	const tabId = await ensureTab(args.tabId);
	await chrome.tabs.update(tabId, { url: args.url });
	await waitLoaded(tabId);
	const tab = await chrome.tabs.get(tabId);
	return { tabId, url: tab.url, title: tab.title };
}

/* 等 tab 加载完成（tabs API，无调试横幅） */
function waitLoaded(tabId, timeout = 8000) {
	return new Promise((resolve) => {
		const onUpd = (id, info) => { if (id === tabId && info.status === "complete") done(); };
		const done = () => { chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(timer); resolve(); };
		const timer = setTimeout(done, timeout);
		chrome.tabs.onUpdated.addListener(onUpd);
	});
}

async function opScreenshot(args) {
	const tabId = await ensureTab(args.tabId);
	return withCdp(tabId, async (id) => {
		const r = await cdp(id, "Page.captureScreenshot", { format: "png" });
		const tab = await chrome.tabs.get(id);
		return { pngBase64: r.data, url: tab.url, title: tab.title };
	});
}

/* 无横幅注入：click / read_text 走 chrome.scripting（隔离世界可读 DOM、能派发合成点击） */
async function inPage(tabId, func, args) {
	const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
	return res?.result;
}

async function opClick(args) {
	if (!args.selector) throw new Error("click requires args.selector");
	const tabId = await ensureTab(args.tabId);
	const v = await inPage(tabId, (sel) => {
		const el = document.querySelector(sel);
		if (!el) return { ok: false, error: "not found: " + sel };
		el.scrollIntoView({ block: "center" });
		el.click();
		return { ok: true, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 80) };
	}, [String(args.selector)]);
	if (!v || v.ok === false) throw new Error(v?.error || "click failed");
	return { tabId, clicked: v.tag, text: v.text };
}

/* eval_js 需要主世界/绕 CSP，保留 CDP；withCdp 用完立即 detach，横幅只在操作瞬间闪现 */
async function opEvalJs(args) {
	if (typeof args.expression !== "string") throw new Error("eval_js requires args.expression");
	const tabId = await ensureTab(args.tabId);
	return withCdp(tabId, async (id) => {
		const r = await cdp(id, "Runtime.evaluate", {
			expression: args.expression,
			returnByValue: true,
			awaitPromise: true,
			userGesture: true,
		});
		if (r?.exceptionDetails) {
			throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "evaluation threw");
		}
		return { tabId: id, value: r?.result?.value };
	});
}

async function opReadText(args) {
	const tabId = await ensureTab(args.tabId);
	const limit = Math.min(Number(args.limit) || 40000, 200000);
	const [tab, text] = await Promise.all([
		chrome.tabs.get(tabId),
		inPage(tabId, (max) => (document.body ? document.body.innerText.slice(0, max) : ""), [limit]),
	]);
	return { tabId, url: tab.url, title: tab.title, text: text || "", truncated: (text || "").length >= limit };
}

async function opTabsList() {
	const tabs = await chrome.tabs.query({});
	return {
		tabs: tabs.map((t) => ({
			id: t.id, title: t.title, url: t.url, active: t.active,
			agentGroup: agentGroupId != null && t.groupId === agentGroupId,
		})),
	};
}

async function opCloseTab(args) {
	const tabId = args.tabId ?? agentTabId;
	if (tabId == null) throw new Error("no agent tab to close (navigate first or pass args.tabId)");
	await chrome.tabs.remove(tabId);
	if (agentTabId === tabId) agentTabId = null;
	return { closed: tabId };
}

const OPS = {
	navigate: opNavigate,
	screenshot: opScreenshot,
	click: opClick,
	eval_js: opEvalJs,
	read_text: opReadText,
	tabs_list: opTabsList,
	close_tab: opCloseTab,
};

async function handleCmd(m) {
	try {
		const fn = OPS[m.op];
		if (!fn) throw new Error(`unknown op: ${m.op} (supported: ${Object.keys(OPS).join(", ")})`);
		const data = await fn(m.args || {});
		send({ t: "cmd-result", id: m.id, ok: true, data });
	} catch (e) {
		send({ t: "cmd-result", id: m.id, ok: false, error: String(e?.message || e) });
	}
}

/* ---------------- popup 交互 / 生命周期 ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.t === "status") {
		chrome.permissions.contains({ origins: ["<all_urls>"] }).then((granted) => {
			sendResponse({ connected: !!(ws && ws.readyState === 1), granted });
		});
		return true; // 异步 sendResponse
	}
	/* 确认窗按钮：同意 → 带原 nonce 回服务端；拒绝 → 通知服务端作废 */
	if (msg?.t === "pair-approve") {
		if (msg.nonce && msg.nonce === pendingPairNonce) send({ t: "pair-approve", nonce: msg.nonce });
		if (consentWinId != null) { try { chrome.windows.remove(consentWinId); } catch {} }
		sendResponse({ ok: true });
	}
	if (msg?.t === "pair-deny") {
		if (msg.nonce) send({ t: "pair-deny", nonce: msg.nonce });
		pendingPairNonce = null;
		if (consentWinId != null) { try { chrome.windows.remove(consentWinId); } catch {} }
		sendResponse({ ok: true });
	}
	return false;
});

chrome.runtime.onInstalled.addListener(() => {
	chrome.alarms.create("ad-watchdog", { periodInMinutes: 1 });
	connect();
});
chrome.runtime.onStartup.addListener(() => {
	chrome.alarms.create("ad-watchdog", { periodInMinutes: 1 });
	connect();
});
chrome.alarms.onAlarm.addListener((a) => {
	if (a.name === "ad-watchdog" && !(ws && ws.readyState === 1)) connect();
});

connect();
