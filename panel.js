function isChatGPTConversationUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("https://chatgpt.com/") || url.startsWith("https://chat.openai.com/")) &&
    url.includes("/c/")
  );
}

function convKey(convId) {
  return `conv:${convId}`;
}

function extractConvIdFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/c\/([^\/?#]+)/); // ✅ marche aussi pour /g/.../c/...
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// ✅ cherche une conversation ChatGPT dans TOUTES les fenêtres
async function getTargetChatGPTTab() {
  const tabs = await chrome.tabs.query({}); // pas de filtre de fenêtre

  // priorité: tab actif sur conversation
  let tab = tabs.find((t) => t.active && isChatGPTConversationUrl(t.url));
  if (tab) return tab;

  // sinon: n'importe quel tab conversation
  tab = tabs.find((t) => isChatGPTConversationUrl(t.url));
  return tab || null;
}

async function loadSnapshotForTargetTab() {
  const tab = await getTargetChatGPTTab();
  if (!tab?.url) return { tab: null, snapshot: null };

  const convId = extractConvIdFromUrl(tab.url);
  if (!convId) return { tab, snapshot: null };

  const res = await chrome.storage.local.get(convKey(convId));
  return { tab, snapshot: res[convKey(convId)] || null };
}

async function focusMsg(msgId, index) {
  const tab = await getTargetChatGPTTab();
  if (!tab?.id) return;

  // ✅ amène au bon endroit visuellement
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});

  // ✅ envoie aussi l’index en fallback
  await chrome.tabs.sendMessage(tab.id, { type: "FOCUS_MSG", msgId, index }).catch(() => {});
}

async function rescan() {
  const tab = await getTargetChatGPTTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "RESCAN" }).catch(() => {});
}

function escapeHtml(s) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render(tab, snapshot, query = "") {
  const meta = document.getElementById("meta");
  const list = document.getElementById("list");

  if (!tab) {
    meta.textContent =
      "Aucun onglet conversation ChatGPT (/c/...) détecté. Ouvre une conversation ChatGPT (même dans un GPT / projet), puis clique Rescan.";
    list.innerHTML = "";
    return;
  }

  if (!snapshot) {
    meta.textContent =
      `Onglet cible: ${tab.title || tab.url} • Snapshot absent. Clique “Rescan”.`;
    list.innerHTML = "";
    return;
  }

  const items = (snapshot.items || []).slice().sort((a, b) => a.index - b.index);
  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter((x) => (x.preview || "").toLowerCase().includes(q)) : items;

  meta.textContent = `Onglet cible: ${tab.title || tab.url} • Conv: ${snapshot.convId} • nodes: ${items.length}`;

  list.innerHTML = "";
  for (const it of filtered) {
    const div = document.createElement("div");
    div.className = `node ${it.role || "unknown"}`;
    div.innerHTML = `
      <div>
        <span class="badge ${it.role}">${it.role}</span>
        <span class="small">#${it.index} • ${it.msgId}</span>
      </div>
      <div style="margin-top:6px">${escapeHtml(it.preview || "")}</div>
    `;
    div.addEventListener("click", () => focusMsg(it.msgId, it.index));
    list.appendChild(div);
  }
}

async function refresh() {
  const { tab, snapshot } = await loadSnapshotForTargetTab();
  const q = document.getElementById("search").value || "";
  render(tab, snapshot, q);
}

document.getElementById("search").addEventListener("input", refresh);
document.getElementById("rescan").addEventListener("click", async () => {
  await rescan();
  setTimeout(refresh, 350);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CONV_UPDATED") refresh();
});

refresh();
let lastUrl = null;

setInterval(async () => {
  const tab = await getTargetChatGPTTab();
  const url = tab?.url || null;
  if (url && url !== lastUrl) {
    lastUrl = url;
    refresh();
  }
}, 800);
