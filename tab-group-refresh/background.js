const MENU_ID = "refresh-tab-group";

async function refreshGroup(groupId, bypassCache = false) {
  if (groupId == null || groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return 0;
  const tabs = await chrome.tabs.query({ groupId });
  await Promise.all(tabs.map((t) => chrome.tabs.reload(t.id, { bypassCache })));
  return tabs.length;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Refresh this tab group",
    contexts: ["page", "frame", "selection", "link", "image"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab) refreshGroup(tab.groupId);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "refresh-current-group") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) refreshGroup(tab.groupId);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "refreshGroup") {
    refreshGroup(msg.groupId, msg.bypassCache).then((count) => sendResponse({ count }));
    return true;
  }
});
