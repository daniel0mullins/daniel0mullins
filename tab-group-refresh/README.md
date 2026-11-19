# Tab Group Refresh

Chrome extension (Manifest V3) that reloads every tab in a tab group.

## Install
1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.

## Use
- **Toolbar popup**: lists the tab groups in the current window with a **Refresh** button for each. Check *Hard reload* to bypass the cache.
- **Right-click** any page in a group → **Refresh this tab group**.
- **Keyboard**: `Alt+Shift+R` refreshes the group of the active tab. Change it at `chrome://extensions/shortcuts`.

Tabs not in a group are ignored by the context menu and shortcut.
