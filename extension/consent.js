const nonce = new URLSearchParams(location.search).get("nonce") || "";

document.getElementById("approve").addEventListener("click", () => {
	chrome.runtime.sendMessage({ t: "pair-approve", nonce }).finally(() => window.close());
});
document.getElementById("deny").addEventListener("click", () => {
	chrome.runtime.sendMessage({ t: "pair-deny", nonce }).finally(() => window.close());
});
