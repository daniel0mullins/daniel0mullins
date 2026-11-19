const COLORS = {
  grey: "#5f6368", blue: "#1a73e8", red: "#d93025", yellow: "#f9ab00",
  green: "#188038", pink: "#d01884", purple: "#a142f4", cyan: "#007b83", orange: "#fa903e"
};

async function render() {
  const win = await chrome.windows.getCurrent();
  const groups = await chrome.tabGroups.query({ windowId: win.id });
  const list = document.getElementById("groups");
  document.getElementById("empty").hidden = groups.length > 0;

  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    const li = document.createElement("li");

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = COLORS[g.color] || COLORS.grey;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = g.title || "(untitled)";

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = tabs.length;

    const btn = document.createElement("button");
    btn.textContent = "Refresh";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await chrome.runtime.sendMessage({
        type: "refreshGroup",
        groupId: g.id,
        bypassCache: document.getElementById("bypass").checked
      });
      btn.textContent = "Done";
    });

    li.append(dot, name, count, btn);
    list.append(li);
  }
}

render();
