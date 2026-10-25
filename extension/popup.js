const $ = (id) => document.getElementById(id);

const STATE_TEXT = {
	connected: "Connected to AgentDeck",
	disconnected: "Server unreachable — is `node server.mjs` running?",
	"awaiting-pair": "Waiting — click “Connect browser” in AgentDeck, then approve the popup",
	"no-token": "Not paired — click “Connect browser” in AgentDeck, then approve the popup",
};

async function refresh() {
	const { wsState = "" } = await chrome.storage.local.get("wsState");
	const st = await chrome.runtime.sendMessage({ t: "status" }).catch(() => ({ connected: false, granted: false }));
	$("dot").classList.toggle("on", !!st.connected);
	$("state").innerHTML = st.connected
		? "Connected to AgentDeck"
		: `<b>${STATE_TEXT[wsState] || "Offline"}</b>`;
	$("grant").textContent = st.granted ? "✓ Site access granted" : "Grant access to all sites…";
}

$("grant").addEventListener("click", async () => {
	await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => {});
	refresh();
});

$("docs").addEventListener("click", () => {
	chrome.tabs.create({ url: chrome.runtime.getURL("tools.html") });
	window.close();
});

refresh();
