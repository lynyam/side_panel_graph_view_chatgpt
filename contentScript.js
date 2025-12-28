(() => {
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function getConversationId() {
    const m = location.pathname.match(/\/c\/([^\/]+)/);
    if (m) return m[1];
    return fnv1a(location.pathname);
  }

  function pickTurnElements() {
    let els = Array.from(document.querySelectorAll("article[data-testid^='conversation-turn-']"));
    if (els.length) return els;

    els = Array.from(document.querySelectorAll("[data-message-author-role]"));
    if (els.length) return els;

    els = Array.from(document.querySelectorAll("article[data-testid*='conversation-turn']"));
    return els;
  }

  function extractRole(turnEl) {
    const roleAttr = turnEl.getAttribute("data-message-author-role");
    if (roleAttr) return roleAttr;

    const sr = turnEl.querySelector("h6.sr-only");
    const label = sr?.textContent?.toLowerCase() || "";
    if (label.includes("you")) return "user";
    if (label.includes("chatgpt") || label.includes("assistant")) return "assistant";
    return "unknown";
  }

  function extractText(turnEl) {
    return (turnEl.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function ensureMessageId(turnEl, index, role, text) {
    if (turnEl.id && turnEl.id.startsWith("msg-")) return turnEl.id;

    const dt = turnEl.getAttribute("data-testid") || "";
    const base = dt ? `${dt}|${role}|${index}` : `${role}|${index}|${text.slice(0, 200)}`;
    const id = `msg-${fnv1a(base)}`;
    turnEl.id = id;
    return id;
  }

  async function saveConversationSnapshot(snapshot) {
    const convId = getConversationId();
    const key = `conv:${convId}`;
    await chrome.storage.local.set({ [key]: snapshot });
  }

  let scanning = false;

  async function scanAndPersist() {
    if (scanning) return;
    scanning = true;
    try {
      const convId = getConversationId();
      const url = location.href.split("#")[0];

      const turns = pickTurnElements();
      if (!turns.length) return;

      const items = [];
      for (let i = 0; i < turns.length; i++) {
        const el = turns[i];
        const role = extractRole(el);
        const text = extractText(el);
        if (!text || text.length < 2) continue;

        const msgId = ensureMessageId(el, i, role, text);

        items.push({
          msgId,
          role,
          index: i,
          preview: text.slice(0, 220),
          hash: fnv1a(text),
          seenAt: Date.now()
        });
      }

      await saveConversationSnapshot({
        convId,
        url,
        updatedAt: Date.now(),
        items
      });

      chrome.runtime.sendMessage({ type: "CONV_UPDATED", convId }).catch(() => {});
    } finally {
      scanning = false;
    }
  }

  function focusMessage(msgId) {
    const el = document.getElementById(msgId);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("oai-graph-focus");
    setTimeout(() => el.classList.remove("oai-graph-focus"), 2000);
    return true;
  }

  function focusFromHash() {
    const m = location.hash.match(/msg=([^&]+)/);
    if (!m) return;
    const msgId = decodeURIComponent(m[1]);
    setTimeout(() => {
      if (!focusMessage(msgId)) scanAndPersist().then(() => setTimeout(() => focusMessage(msgId), 300));
    }, 200);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "FOCUS_MSG" && msg.msgId) {
  		history.replaceState(null, "", `#msg=${encodeURIComponent(msg.msgId)}`);

	// 1) essaie via msgId
	let ok = focusMessage(msg.msgId);

	// 2) fallback via index
	if (!ok && typeof msg.index === "number") {
		const turns = pickTurnElements();
		const el = turns[msg.index];
		if (el) {
		// s’assure d’avoir un id puis focus
		const role = extractRole(el);
		const text = extractText(el);
		const id = ensureMessageId(el, msg.index, role, text);
		ok = focusMessage(id);
		}
  	}

	// 3) si toujours pas OK, rescanner et retenter
	if (!ok) scanAndPersist().then(() => setTimeout(() => focusMessage(msg.msgId), 300));
		sendResponse({ ok: true });
		return true;
	}
  });

  window.addEventListener("hashchange", focusFromHash);

  const obs = new MutationObserver(() => {
    clearTimeout(window.__oaiGraphDebounce);
    window.__oaiGraphDebounce = setTimeout(scanAndPersist, 250);
  });

  function init() {
    obs.observe(document.documentElement, { childList: true, subtree: true });
    scanAndPersist();
    focusFromHash();
  }

  init();
})();
