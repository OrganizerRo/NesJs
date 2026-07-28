
const LS_KEY = "nesjs_gamepad_mappings";
const LISTEN_TIMEOUT_MS = 5000;
const TIMEOUT_MESSAGE_DURATION_MS = 1500;
const STATUS_MESSAGE_DURATION_MS = 3000;

const NES_BUTTONS = ["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"];

const DEFAULT_MAPPING = {
  buttons: {
    0: "A",
    1: "B",
    8: "SELECT",
    9: "START",
    12: "UP",
    13: "DOWN",
    14: "LEFT",
    15: "RIGHT"
  },
  axes: { deadzone: 0.5 }
};

// Working copy of mappings, indexed [0] for P1, [1] for P2
let mappings = [
  JSON.parse(JSON.stringify(DEFAULT_MAPPING)),
  JSON.parse(JSON.stringify(DEFAULT_MAPPING))
];

let currentPlayer = 1; // 1 or 2
let listeningFor = null; // NES button name currently being remapped, or null
let listenRAF = null;    // requestAnimationFrame handle for listening loop
let listenTimeout = null; // timeout handle for auto-cancel

// Load mappings from localStorage on startup
(function() {
  try {
    let saved = localStorage.getItem(LS_KEY);
    if(saved) {
      let parsed = JSON.parse(saved);
      if(Array.isArray(parsed) && parsed.length === 2 &&
         parsed[0].buttons && parsed[0].axes &&
         parsed[1].buttons && parsed[1].axes) {
        mappings = parsed;
      }
    }
  } catch(e) {
    // ignore, keep defaults
  }
  renderTable();
})();

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
    remapBtn.onclick = cancelListening;
  }

  // 5-second timeout
  listenTimeout = setTimeout(function() {
    cancelListening();
    let cell = document.getElementById("assign-" + nesBtn);
    if(cell) {
      cell.textContent = "(timed out — no input received)";
      cell.className = "assignment-cell";
    }
    setTimeout(function() { renderTable(); }, TIMEOUT_MESSAGE_DURATION_MS);
  }, LISTEN_TIMEOUT_MS);

  // Polling loop
  function poll() {
    let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for(let i = 0; i < gamepads.length; i++) {
      let gp = gamepads[i];
      if(!gp) continue;
      for(let b = 0; b < gp.buttons.length; b++) {
        if(gp.buttons[b].pressed && !baseline[i + ":" + b]) {
          // Assign this gamepad button to the NES button
          assignButton(nesBtn, b);
          clearTimeout(listenTimeout);
          listenTimeout = null;
          listeningFor = null;
          listenRAF = null;
          renderTable();
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
    if(!gp) continue;
    for(let b = 0; b < gp.buttons.length; b++) {
      if(gp.buttons[b].pressed) {
        state[i + ":" + b] = true;
      }
    }
  }
  return state;
}

function cancelListening() {
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
  if(prev) {
    renderTable();
  }
}

// Assign gamepad button index to a NES button for the current player.
// Removes any previous assignment of the same gamepad button index first.
function assignButton(nesBtn, gamepadBtnIdx) {
  let mapping = currentMapping();
  // Remove any existing mapping of this gamepad button
  delete mapping.buttons[gamepadBtnIdx];
  // Remove any previous assignment of this NES button
  Object.keys(mapping.buttons).forEach(function(k) {
    if(mapping.buttons[k] === nesBtn) {
      delete mapping.buttons[k];
    }
  });
  mapping.buttons[gamepadBtnIdx] = nesBtn;
}

function resetToDefaults() {
  cancelListening();
  mappings[currentPlayer - 1] = JSON.parse(JSON.stringify(DEFAULT_MAPPING));
  renderTable();
  showSaveStatus("Reset to defaults. Press Save to persist.", false);
}

function saveMappings() {
  cancelListening();
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(mappings));
    showSaveStatus("✔ Saved successfully!", false);
  } catch(e) {
    showSaveStatus("✘ Save failed: " + e, true);
  }
}

function showSaveStatus(msg, isError) {
  let el = document.getElementById("save-status");
  el.textContent = msg;
  el.className = "status-msg " + (isError ? "err" : "ok");
  setTimeout(function() { el.textContent = ""; el.className = "status-msg"; }, STATUS_MESSAGE_DURATION_MS);
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

  // Strip JS variable wrapper if present (supports simple patterns like
  // "const name = ..." or "let name = ..."; does not handle export/multiline declarations)
  let jsonStr = raw.replace(/^\s*(?:const|let|var)\s+\w+\s*=\s*/, "").replace(/;\s*$/, "");

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch(e) {
    showEiStatus("✘ Invalid JSON: " + e.message, true);
    return;
  }

  if(!Array.isArray(parsed) || parsed.length !== 2) {
    showEiStatus("✘ Expected an array of 2 player mappings.", true);
    return;
  }
  for(let i = 0; i < 2; i++) {
    if(!parsed[i].buttons || typeof parsed[i].buttons !== "object" ||
       !parsed[i].axes || typeof parsed[i].axes.deadzone !== "number") {
      showEiStatus("✘ Player " + (i + 1) + " mapping is missing required fields (buttons, axes.deadzone).", true);
      return;
    }
    // Validate all values in buttons are valid NES button names
    let vals = Object.values(parsed[i].buttons);
    for(let j = 0; j < vals.length; j++) {
      if(NES_BUTTONS.indexOf(vals[j]) === -1) {
        showEiStatus('✘ Unknown NES button name "' + vals[j] + '" in player ' + (i + 1) + ' mapping.', true);
        return;
      }
    }
  }

  mappings = parsed;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(mappings));
  } catch(e) {
    // non-fatal
  }
  cancelListening();
  renderTable();
  showEiStatus("✔ Imported and saved successfully!", false);
}

function showEiStatus(msg, isError) {
  let el = document.getElementById("ei-status");
  el.textContent = msg;
  el.className = "ei-status " + (isError ? "err" : "ok");
}

// Wire up all button event listeners (avoids inline onclick in HTML)
document.getElementById("tab-p1").addEventListener("click", function() { switchTab(1); });
document.getElementById("tab-p2").addEventListener("click", function() { switchTab(2); });
document.getElementById("btn-reset").addEventListener("click", resetToDefaults);
document.getElementById("btn-save").addEventListener("click", saveMappings);
document.getElementById("btn-export-json").addEventListener("click", exportJSON);
document.getElementById("btn-export-js").addEventListener("click", exportJS);
document.getElementById("btn-import").addEventListener("click", importMapping);
