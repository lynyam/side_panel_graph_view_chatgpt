(() => {
  // -------------------------
  // Utils
  // -------------------------
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // -------------------------
  // Conversation identity
  // -------------------------
  function getConversationId() {
    // Supporte /c/<id> ET /g/.../c/<id>
    const m = location.pathname.match(/\/c\/([^\/?#]+)/);
    if (m) return m[1];
    return fnv1a(location.pathname);
  }

  // -------------------------
  // DOM extraction
  // -------------------------
  function pickTurnElements() {
    // 1) le plus fiable: data-testid conversation-turn-*
    let els = Array.from(
      document.querySelectorAll("[data-testid^='conversation-turn-']")
    );
    if (els.length) return els;

    // 2) fallback: contient conversation-turn
    els = Array.from(document.querySelectorAll("[data-testid*='conversation-turn']"));
    if (els.length) return els;

    // 3) fallback extrême: nodes role (souvent sur enfants)
    els = Array.from(document.querySelectorAll("[data-message-author-role]"));
    return els;
  }

  function extractRole(turnEl, index) {
    // 1) direct
    const direct = turnEl.getAttribute("data-message-author-role");
    if (direct) return direct;

    // 2) sur un enfant
    const child = turnEl.querySelector("[data-message-author-role]");
    if (child) {
      const r = child.getAttribute("data-message-author-role");
      if (r) return r;
    }

    // 3) label a11y (si présent)
    const sr = turnEl.querySelector("h6.sr-only, .sr-only");
    const label = (sr?.textContent || "").toLowerCase();
    if (label.includes("you")) return "user";
    if (label.includes("chatgpt") || label.includes("assistant")) return "assistant";

    // 4) fallback via texte (utile si la UI affiche "You said:" / "ChatGPT said:")
    const txt = (turnEl.innerText || "").toLowerCase();
    if (txt.startsWith("you said:") || txt.includes("\nyou said:")) return "user";
    if (txt.startsWith("chatgpt said:") || txt.includes("\nchatgpt said:")) return "assistant";

    // 5) fallback via data-testid conversation-turn-N
    const dt = turnEl.getAttribute("data-testid") || "";
    const m = dt.match(/conversation-turn-(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) return n % 2 === 0 ? "user" : "assistant";
    }

    // 6) dernier recours: alternance
    if (typeof index === "number") return index % 2 === 0 ? "user" : "assistant";

    return "unknown";
  }

  function extractText(turnEl) {
    return (turnEl.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function ensureMessageId(turnEl, index, role, text) {
    if (turnEl.id && turnEl.id.startsWith("msg-")) return turnEl.id;

    const dt = turnEl.getAttribute("data-testid") || "";
    const base = dt
      ? `${dt}|${role}|${index}`
      : `${role}|${index}|${text.slice(0, 200)}`;

    const id = `msg-${fnv1a(base)}`;
    turnEl.id = id;
    return id;
  }

  // -------------------------
  // Storage
  // -------------------------
  async function saveConversationSnapshot(snapshot) {
    const convId = getConversationId();
    const key = `conv:${convId}`;
    await chrome.storage.local.set({ [key]: snapshot });
  }

  async function loadConversationSnapshot() {
    const convId = getConversationId();
    const key = `conv:${convId}`;
    const res = await chrome.storage.local.get(key);
    return res[key] || null;
  }

  function mergeItems(prevItems, newItems) {
    const map = new Map();
    for (const it of prevItems || []) map.set(it.msgId, it);
    for (const it of newItems || []) map.set(it.msgId, it);
    return Array.from(map.values()).sort((a, b) => a.index - b.index);
  }

  // -------------------------
  // Scan logic
  // -------------------------
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

        const text = extractText(el);
        if (!text || text.length < 2) continue;

        const role = extractRole(el, i);
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

      const prev = (await loadConversationSnapshot()) || { convId, url, items: [] };
      const mergedItems = mergeItems(prev.items, items);

      await saveConversationSnapshot({
        convId,
        url,
        updatedAt: Date.now(),
        items: mergedItems
      });

      chrome.runtime.sendMessage({ type: "CONV_UPDATED", convId }).catch(() => {});
    } finally {
      scanning = false;
    }
  }

  // -------------------------
  // Full rescan crawl (loads older messages)
  // -------------------------
  async function fullRescanCrawl() {
    const startY = window.scrollY;

    // remonte en “pages” pour forcer le lazy-load
    for (let step = 0; step < 80; step++) {
      await scanAndPersist();

      const before = window.scrollY;
      window.scrollBy(0, -Math.floor(window.innerHeight * 0.85));
      await sleep(220);

      if (window.scrollY === before) break; // on est en haut ou bloqué
    }

    await scanAndPersist();
    window.scrollTo(0, startY);
  }

  // -------------------------
  // Focus / deep link
  // -------------------------
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
      if (!focusMessage(msgId)) {
        scanAndPersist().then(() => setTimeout(() => focusMessage(msgId), 300));
      }
    }, 200);
  }

  // -------------------------
  // Message handler (from panel)
  // -------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "RESCAN") {
      fullRescanCrawl()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error("RESCAN failed", e);
          sendResponse({ ok: false });
        });
      return true; // async
    }

    if (msg?.type === "FOCUS_MSG" && msg.msgId) {
      history.replaceState(null, "", `#msg=${encodeURIComponent(msg.msgId)}`);

      // 1) try msgId
      let ok = focusMessage(msg.msgId);

      // 2) fallback by index
      if (!ok && typeof msg.index === "number") {
        const turns = pickTurnElements();
        const el = turns[msg.index];
        if (el) {
          const text = extractText(el);
          const role = extractRole(el, msg.index);
          const id = ensureMessageId(el, msg.index, role, text);
          ok = focusMessage(id);
        }
      }

      // 3) last resort: scan then retry
      if (!ok) {
        scanAndPersist().then(() =>
          setTimeout(() => focusMessage(msg.msgId), 300)
        );
      }

      sendResponse({ ok: true });
      return true;
    }
  });

  // -------------------------
  // Observe DOM changes
  // -------------------------
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
