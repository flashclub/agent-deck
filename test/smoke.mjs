/**
 * UI 冒烟测试：用 jsdom 真正加载页面并执行内联脚本。
 * 任何加载期运行时错误（如 TDZ、null 引用）都会让本测试失败。
 * 运行：node test/smoke.mjs（无需启动服务器）
 */
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(String(e?.detail || e)));
vc.on("error", (msg) => errors.push(String(msg)));

const dom = new JSDOM(html, {
	url: "http://localhost/",
	runScripts: "dangerously",
	pretendToBeVisual: true,
	virtualConsole: vc,
	beforeParse(window) {
		/* xterm / WebSocket / ResizeObserver 桩 */
		class TerminalStub {
			constructor(opts) { this.options = opts; this._data = []; }
			loadAddon() {}
			open() {}
			onData(cb) { this._dataCb = cb; }
			onResize() {}
			focus() {}
			reset() {}
			write() {}
		}
		class FitAddonStub { fit() {} }
		window.Terminal = TerminalStub;
		window.FitAddon = { FitAddon: FitAddonStub };
		window.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
		window.WebSocket = class {
			constructor() { this.readyState = 0; setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
			send() {}
			close() {}
		};
		window.confirm = () => false;
	},
});

const { window } = dom;
await new Promise((r) => setTimeout(r, 400));

const $$ = (s) => window.document.querySelectorAll(s);
const checks = [
	["脚本零运行时错误", errors.length === 0, errors.slice(0, 2).join(" | ")],
	["4 个窗格已创建", $$(".pane").length === 4, `got ${$$(".pane").length}`],
	["启动器可见（含智能体选择器）", $$(".pane .launcher").length === 4 && $$(".agentBtns").length === 4, ""],
	["默认语言英文（h3 有文案且非中文占位）", ($$(".pane .launcher h3")[0]?.textContent || "").length > 0, ""],
	["语言切换器存在", !!window.document.querySelector("#langZh") && !!window.document.querySelector("#langEn"), ""],
	["顶栏收起按钮存在", !!window.document.querySelector("#barCollapse"), ""],
	["指挥条组件存在", !!window.document.querySelector("#caster") && !!window.document.querySelector("#casterIcon"), ""],
	["标题元素就位", $$(".ptitle").length === 4, `got ${$$(".ptitle").length}`],
];

let fail = 0;
for (const [name, ok, detail] of checks) {
	console.log((ok ? "✅" : "❌") + " " + name + (ok || !detail ? "" : ` — ${detail}`));
	if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
