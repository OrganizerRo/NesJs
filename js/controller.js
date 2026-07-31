const LS_KEY = "nesjs_gamepad_mappings";
const LISTEN_TIMEOUT_MS = 5000;
const STATUS_MESSAGE_DURATION_MS = 3000;

const NES_BUTTONS = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];

// ── Self-contained validation/sanitization helpers ───────────────────────────
// (Intentionally duplicated from main.js; each file is self-contained.)
const NES_BUTTON_NAMES = new Set(NES_BUTTONS);

const DEFAULT_GAMEPAD_MAPPINGS = [
  {
    buttons: { "0": "A", "1": "B", "8": "SELECT", "9": "START", "12": "UP", "13": "DOWN", "14": "LEFT", "15": "RIGHT" },
    axes: { deadzone: 0.5 }
  },
  {
    buttons: { "0": "A", "1": "B", "8": "SELECT", "9": "START", "12": "UP", "13": "DOWN", "14": "LEFT", "15": "RIGHT" },
    axes: { deadzone: 0.5 }
  }
];

function clampDeadzone(v) {
  let n = Number(v);
  if(!Number.isFinite(n)) return 0.5;
  return Math.min(0.95, Math.max(0.05, n));
}

function sanitizePlayerMapping(playerMapping) {
  if(!playerMapping || typeof playerMapping !== "object") return null;
  let inButtons = playerMapping.buttons;
  let inAxes = playerMapping.axes || {};
  if(!inButtons || typeof inButtons !== "object") return null;
  let outButtons = {};
  for(let k in inButtons) {
    if(!/^\d+$/.test(k)) continue;
    if(!NES_BUTTON_NAMES.has(inButtons[k])) continue;
    outButtons[k] = inButtons[k];
  }
  return {
    buttons: outButtons,
    axes: { deadzone: clampDeadzone(inAxes.deadzone) }
  };
}

function sanitizeMappings(rawMappings) {
  if(!Array.isArray(rawMappings) || rawMappings.length !== 2) return null;
  let p1 = sanitizePlayerMapping(rawMappings[0]);
  let p2 = sanitizePlayerMapping(rawMappings[1]);
  if(!p1 || !p2) return null;
  return [p1, p2];
}

// Accept plain JSON array or JS wrapper: const/let/var gamepadMappings = ...;
function parseImportedMappings(text) {
  let trimmed = text.trim();
  let match = trimmed.match(/^\s*(?:const|let|var)\s+\w+\s*=\s*([\s\S]*?)\s*;?\s*$/);
  let jsonCandidate = match ? match[1] : trimmed;
  let parsed = JSON.parse(jsonCandidate);
  return sanitizeMappings(parsed);
}

function loadMappingsSafe() {
  try {
    let raw = localStorage.getItem(LS_KEY);
    if(!raw) return JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
    let parsed = JSON.parse(raw);
    let sanitized = sanitizeMappings(parsed);
    return sanitized || JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
  } catch(e) {
    console.warn("[controller] Failed to load mappings, using defaults.", e);
    return JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
  }
}

function saveMappingsSafe(data) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
    return true;
  } catch(e) {
    console.warn("[controller] Failed to save mappings.", e);
    showSaveStatus("✘ Storage unavailable. Settings won't persist this session.", true);
    return false;
  }
}
// ────────────────────────────────────────────────────────────────────────────

// Working copy of mappings, indexed [0] for P1, [1] for P2
let mappings = loadMappingsSafe();

let currentPlayer = 1; // 1 or 2
let listeningFor = null;        // NES button name currently being remapped, or null
let listeningGamepadIndex = -1; // gamepad index being monitored during remap
let listenRAF = null;           // requestAnimationFrame handle for listening loop
let listenTimeout = null;       // timeout handle for auto-cancel

// Cancel remap if the controller being listened to disconnects
window.addEventListener("gamepaddisconnected", function(e) {
  if(listeningFor !== null && e.gamepad.index === listeningGamepadIndex) {
    cancelListening("Controller disconnected during remap.", true);
  }
});

renderTable();

function switchTab(player) {
  currentPlayer = player;
  document.getElementById("tab-p1").classList.toggle("active", player === 1);
  document.getElementById("tab-p2").classList.toggle("active", player === 2);
  cancelListening();
  renderTable();
}

// Returns the mapping object for the currently selected player
function currentMapping() {
  return mappings[currentPlayer - 1];
}

// Build a human-readable label for the current assignment of a NES button
function assignmentLabel(nesBtn) {
  let mapping = currentMapping();
  let entries = Object.entries(mapping.buttons);
  let assigned = entries.filter(function(kv) { return kv[1] === nesBtn; });
  if(assigned.length === 0) return "(unassigned)";
  return assigned.map(function(kv) { return "Button " + kv[0]; }).join(", ");
}

function renderTable() {
  let tbody = document.getElementById("mapping-body");
  tbody.innerHTML = "";
  NES_BUTTONS.forEach(function(nesBtn) {
    let tr = document.createElement("tr");

    // NES button name cell
    let tdName = document.createElement("td");
    tdName.innerHTML = '<span class="nes-btn-label">' + nesBtn + '</span>';
    tr.appendChild(tdName);

    // Assignment cell
    let tdAssign = document.createElement("td");
    tdAssign.className = "assignment-cell";
    tdAssign.id = "assign-" + nesBtn;
    tdAssign.textContent = assignmentLabel(nesBtn);
    tr.appendChild(tdAssign);

    // Action cell
    let tdAction = document.createElement("td");
    let btn = document.createElement("button");
    btn.className = "remap-btn";
    btn.id = "remap-btn-" + nesBtn;
    btn.textContent = "Remap";
    btn.onclick = function() { startListening(nesBtn); };
    tdAction.appendChild(btn);
    tr.appendChild(tdAction);

    tbody.appendChild(tr);
  });
}

function startListening(nesBtn) {
  if(listeningFor !== null) {
    cancelListening();
  }

  listeningFor = nesBtn;
  listeningGamepadIndex = currentPlayer - 1;

  // Snapshot which buttons are currently pressed so we don't immediately capture them
  let baseline = snapshotButtonsPressed();

  // Update UI
  let assignCell = document.getElementById("assign-" + nesBtn);
  if(assignCell) {
    assignCell.textContent = "Press a button on the gamepad... (5s)";
    assignCell.className = "assignment-cell listening";
  }
  let remapBtn = document.getElementById("remap-btn-" + nesBtn);
  if(remapBtn) {
    remapBtn.textContent = "Cancel";
    remapBtn.className = "remap-btn cancel";
    remapBtn.onclick = function() { cancelListening(); };
  }

  // 5-second timeout
  listenTimeout = setTimeout(function() {
    cancelListening("Remap timed out — no input received.", true);
  }, LISTEN_TIMEOUT_MS);

  // Polling loop
  function poll() {
    let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for(let i = 0; i < gamepads.length; i++) {
      let gp = gamepads[i];
      if(!gp || !gp.buttons) continue;
      for(let b = 0; b < gp.buttons.length; b++) {
        if(gp.buttons[b] && gp.buttons[b].pressed && !baseline[i + ":" + b]) {
          // Assign this gamepad button to the NES button
          assignButton(nesBtn, b);
          clearTimeout(listenTimeout);
          listenTimeout = null;
          listeningFor = null;
          listeningGamepadIndex = -1;
          listenRAF = null;
          renderTable();
          showSaveStatus("Mapped button " + b + " \u2192 " + nesBtn + ". Press Save to persist to storage.", false);
          return;
        }
      }
    }
    if(listeningFor === nesBtn) {
      listenRAF = requestAnimationFrame(poll);
    }
  }
  listenRAF = requestAnimationFrame(poll);
}

function snapshotButtonsPressed() {
  let state = {};
  let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  for(let i = 0; i < gamepads.length; i++) {
    let gp = gamepads[i];
    if(!gp || !gp.buttons) continue;
    for(let b = 0; b < gp.buttons.length; b++) {
      if(gp.buttons[b] && gp.buttons[b].pressed) {
        state[i + ":" + b] = true;
      }
    }
  }
  return state;
}

function cancelListening(msg, isError) {
  if(listenRAF !== null) {
    cancelAnimationFrame(listenRAF);
    listenRAF = null;
  }
  if(listenTimeout !== null) {
    clearTimeout(listenTimeout);
    listenTimeout = null;
  }
  let prev = listeningFor;
  listeningFor = null;
  listeningGamepadIndex = -1;
  if(prev) {
    renderTable();
  }
  if(msg) {
    showSaveStatus(msg, isError !== false);
  }
}

// Assign gamepad button index to a NES button for the current player.
// Removes any previous assignment of the same gamepad button index first.
function assignButton(nesBtn, gamepadBtnIdx) {
  let mapping = currentMapping();
  let key = String(gamepadBtnIdx);
  // Remove any previous assignment of this NES button from all keys
  Object.keys(mapping.buttons).forEach(function(k) {
    if(mapping.buttons[k] === nesBtn) {
      delete mapping.buttons[k];
    }
  });
  // Remove any remaining mapping for this gamepad button (different NES button)
  delete mapping.buttons[key];
  mapping.buttons[key] = nesBtn;
}

function resetToDefaults() {
  cancelListening();
  mappings[currentPlayer - 1] = JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS[currentPlayer - 1]));
  renderTable();
  showSaveStatus("Reset to defaults. Press Save to persist.", false);
}

function saveMappings() {
  cancelListening();
  if(saveMappingsSafe(mappings)) {
    showSaveStatus("✔ Saved successfully!", false);
  }
}

function showSaveStatus(msg, isError) {
  let statusEl = document.getElementById("save-status");
  statusEl.textContent = msg;
  statusEl.className = "status-msg " + (isError ? "err" : "ok");
  setTimeout(function() { statusEl.textContent = ""; statusEl.className = "status-msg"; }, STATUS_MESSAGE_DURATION_MS);
}

// Export / Import

function exportJSON() {
  document.getElementById("mapping-textarea").value =
    JSON.stringify(mappings, null, 2);
  showEiStatus("", false);
}

function exportJS() {
  document.getElementById("mapping-textarea").value =
    "const gamepadMappings = " + JSON.stringify(mappings, null, 2) + ";";
  showEiStatus("", false);
}

function importMapping() {
  let raw = document.getElementById("mapping-textarea").value.trim();
  if(!raw) {
    showEiStatus("✘ Textarea is empty.", true);
    return;
  }

  let sanitized = null;
  try {
    sanitized = parseImportedMappings(raw);
  } catch(e) {
    showEiStatus("✘ Invalid JSON: " + e.message, true);
    return;
  }

  if(!sanitized) {
    showEiStatus("✘ Invalid mapping values. Keeping previous settings.", true);
    return;
  }

  cancelListening();
  mappings = sanitized;
  saveMappingsSafe(mappings);
  renderTable();
  showEiStatus("✔ Imported successfully!", false);
}

function showEiStatus(msg, isError) {
  let statusEl = document.getElementById("ei-status");
  statusEl.textContent = msg;
  statusEl.className = "ei-status " + (isError ? "err" : "ok");
}

// Wire up all button event listeners (avoids inline onclick in HTML)
document.getElementById("tab-p1").addEventListener("click", function() { switchTab(1); });
document.getElementById("tab-p2").addEventListener("click", function() { switchTab(2); });
document.getElementById("btn-reset").addEventListener("click", resetToDefaults);
document.getElementById("btn-save").addEventListener("click", saveMappings);
document.getElementById("btn-export-json").addEventListener("click", exportJSON);
document.getElementById("btn-export-js").addEventListener("click", exportJS);
document.getElementById("btn-import").addEventListener("click", importMapping);

const touchControllerApi = window.TouchControllerConfig;
let touchConfig = touchControllerApi ? touchControllerApi.load() : null;

if(touchControllerApi && touchConfig) {
  renderTouchConfig();

  document.getElementById("btn-touch-reset").addEventListener("click", resetTouchConfig);
  document.getElementById("btn-touch-save").addEventListener("click", saveTouchConfig);
  document.getElementById("btn-touch-export").addEventListener("click", exportTouchConfig);
  document.getElementById("btn-touch-import").addEventListener("click", importTouchConfig);
}

function renderTouchConfig() {
  document.getElementById("touch-enabled").checked = !!touchConfig.enabled;
  document.getElementById("touch-window-height").value = touchConfig.windowedAreaHeight;
  document.getElementById("touch-fullscreen-height").value = touchConfig.fullscreenAreaPercent;

  let tbody = document.getElementById("touch-config-body");
  tbody.innerHTML = "";

  touchControllerApi.BUTTON_ORDER.forEach(function(buttonName) {
    let buttonConfig = touchConfig.buttons[buttonName];
    let tr = document.createElement("tr");
    tr.innerHTML =
      "<td><span class=\"nes-btn-label\">" + buttonName + "</span></td>" +
      "<td><input type=\"number\" min=\"0\" max=\"100\" step=\"1\" data-touch-button=\"" + buttonName + "\" data-touch-field=\"x\" value=\"" + buttonConfig.x + "\"></td>" +
      "<td><input type=\"number\" min=\"0\" max=\"100\" step=\"1\" data-touch-button=\"" + buttonName + "\" data-touch-field=\"y\" value=\"" + buttonConfig.y + "\"></td>" +
      "<td><input type=\"number\" min=\"28\" max=\"120\" step=\"1\" data-touch-button=\"" + buttonName + "\" data-touch-field=\"size\" value=\"" + buttonConfig.size + "\"></td>";
    tbody.appendChild(tr);
  });
}

function collectTouchConfigFromForm() {
  let nextConfig = touchControllerApi.cloneDefaults();
  nextConfig.enabled = document.getElementById("touch-enabled").checked;
  nextConfig.windowedAreaHeight = document.getElementById("touch-window-height").value;
  nextConfig.fullscreenAreaPercent = document.getElementById("touch-fullscreen-height").value;

  let inputs = document.querySelectorAll("#touch-config-body input[data-touch-button]");
  for(let i = 0; i < inputs.length; i++) {
    let input = inputs[i];
    let buttonName = input.getAttribute("data-touch-button");
    let field = input.getAttribute("data-touch-field");
    if(!nextConfig.buttons[buttonName]) {
      nextConfig.buttons[buttonName] = {};
    }
    nextConfig.buttons[buttonName][field] = input.value;
  }

  return touchControllerApi.sanitize(nextConfig);
}

function resetTouchConfig() {
  touchConfig = touchControllerApi.cloneDefaults();
  renderTouchConfig();
  showTouchStatus("Reset touch layout. Press Save Touch Layout to persist.", false);
}

function saveTouchConfig() {
  touchConfig = touchControllerApi.save(collectTouchConfigFromForm());
  renderTouchConfig();
  showTouchStatus("✔ Touch layout saved!", false);
}

function exportTouchConfig() {
  document.getElementById("touch-textarea").value = JSON.stringify(collectTouchConfigFromForm(), null, 2);
  showTouchEiStatus("", false);
}

function importTouchConfig() {
  let raw = document.getElementById("touch-textarea").value.trim();
  if(!raw) {
    showTouchEiStatus("✘ Textarea is empty.", true);
    return;
  }

  try {
    touchConfig = touchControllerApi.save(touchControllerApi.parseImported(raw));
    renderTouchConfig();
    showTouchEiStatus("✔ Imported successfully!", false);
    showTouchStatus("✔ Touch layout saved!", false);
  } catch(e) {
    showTouchEiStatus("✘ Invalid JSON: " + e.message, true);
  }
}

function showTouchStatus(msg, isError) {
  let statusEl = document.getElementById("touch-save-status");
  statusEl.textContent = msg;
  statusEl.className = "status-msg " + (isError ? "err" : "ok");
  setTimeout(function() { statusEl.textContent = ""; statusEl.className = "status-msg"; }, STATUS_MESSAGE_DURATION_MS);
}

function showTouchEiStatus(msg, isError) {
  let statusEl = document.getElementById("touch-ei-status");
  statusEl.textContent = msg;
  statusEl.className = "ei-status " + (isError ? "err" : "ok");
}
