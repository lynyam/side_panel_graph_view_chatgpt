function isChatGPT(url) {
  return (
    url?.startsWith("https://chatgpt.com/") ||
    url?.startsWith("https://chat.openai.com/")
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  // Ouvre le side panel quand l'utilisateur clique sur l'icône de l'extension
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Active/désactive le side panel selon l’URL (optionnel mais propre)
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab?.url) return;

  if (isChatGPT(tab.url)) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "panel.html",
      enabled: true
    });
  } else {
    await chrome.sidePanel.setOptions({
      tabId,
      enabled: false
    });
  }
});
