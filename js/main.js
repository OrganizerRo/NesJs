
let nes = new Nes();
let audioHandler = new AudioHandler();
let paused = false;
let loaded = false;
let pausedInBg = false;
let loopId = 0;
let loadedName = "";
const NES_FRAME_MS = 1000 / 60.0988;
const MAX_SKIP_FRAMES = 4;
const MAX_FRAME_DEBT_MS = NES_FRAME_MS * (MAX_SKIP_FRAMES + 1);
let lastFrameTime = 0;
let frameDebt = 0;
let isFullscreen = false;
let fsAspectMode = localStorage.getItem("nesjs_fs_aspect") || "keep";

let c = el("output");
c.width = 256;
c.height = 240;
let ctx = c.getContext("2d");
let imgData = ctx.createImageData(256, 240);

let screenWrap = el("screen-wrap");
let touchControllerArea = el("touch-controller-area");
let touchControllerToggle = el("touch-controller-toggle");
const TOUCH_CONTROLLER_BUTTONS = window.TouchControllerConfig
  ? window.TouchControllerConfig.BUTTON_ORDER.slice()
  : ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "START", "B", "A"];
let touchControllerConfig = window.TouchControllerConfig
  ? window.TouchControllerConfig.load()
  : { enabled: false, windowedAreaHeight: 180, fullscreenAreaPercent: 30, buttons: {} };
let touchControllerAssignments = {};
let touchControllerButtons = {};
if (fsAspectMode === "stretch") {
  screenWrap.classList.add("fs-stretch");
}
el("aspect-toggle").textContent = "Aspect: " + (fsAspectMode === "stretch" ? "Stretch" : "Keep");
buildTouchController();
bindTouchControllerEvents();
applyTouchControllerConfig();

c.addEventListener("dblclick", function() {
  if (!document.fullscreenElement) {
    if (screenWrap.requestFullscreen) {
      screenWrap.requestFullscreen().catch(function(err) {
        log("Fullscreen error: " + err.message);
      });
    } else if (screenWrap.webkitRequestFullscreen) {
      screenWrap.webkitRequestFullscreen();
    }
  }
});

c.addEventListener("click", function() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  }
});

let controlsP1 = {
  arrowright: nes.INPUT.RIGHT,
  arrowleft: nes.INPUT.LEFT,
  arrowdown: nes.INPUT.DOWN,
  arrowup: nes.INPUT.UP,
  enter: nes.INPUT.START,
  shift: nes.INPUT.SELECT,
  a: nes.INPUT.B,
  z: nes.INPUT.A
}
let controlsP2 = {
  l: nes.INPUT.RIGHT,
  j: nes.INPUT.LEFT,
  k: nes.INPUT.DOWN,
  i: nes.INPUT.UP,
  p: nes.INPUT.START,
  o: nes.INPUT.SELECT,
  t: nes.INPUT.B,
  g: nes.INPUT.A
}

// ── Gamepad mapping constants ────────────────────────────────────────────────
const NES_BUTTON_NAMES = new Set(["A", "B", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT"]);
const GAMEPAD_MAPPINGS_STORAGE_KEY = "nesjs_gamepad_mappings";
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

function loadGamepadMappings() {
  try {
    let raw = localStorage.getItem(GAMEPAD_MAPPINGS_STORAGE_KEY);
    if(!raw) return JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
    let parsed = JSON.parse(raw);
    let sanitized = sanitizeMappings(parsed);
    return sanitized || JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
  } catch(e) {
    console.warn("[gamepad] Failed to load mappings from storage, using defaults.", e);
    return JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPINGS));
  }
}

// Per-player previous button state for transition detection
let prevGamepadButtons = [[], []];
// Per-player previous axis-synthesized direction state
let prevAxisState = [
  { left: false, right: false, up: false, down: false },
  { left: false, right: false, up: false, down: false }
];

function releaseAllButtonsForPlayer(playerIdx) {
  let player = playerIdx + 1;
  NES_BUTTON_NAMES.forEach(function(b) {
    nes.setButtonReleased(player, nes.INPUT[b]);
  });
  prevGamepadButtons[playerIdx] = [];
  prevAxisState[playerIdx] = { left: false, right: false, up: false, down: false };
}
// ────────────────────────────────────────────────────────────────────────────

let gamepadMappings = loadGamepadMappings();

zip.workerScriptsPath = "lib/";
zip.useWebWorkers = false;

el("rom").onchange = function(e) {
  audioHandler.resume();
  let freader = new FileReader();
  freader.onload = function() {
    let buf = freader.result;
    if(e.target.files[0].name.slice(-4) === ".zip") {
      // use zip.js to read the zip
      let blob = new Blob([buf]);
      zip.createReader(new zip.BlobReader(blob), function(reader) {
        reader.getEntries(function(entries) {
          if(entries.length) {
            let found = false;
            for(let i = 0; i < entries.length; i++) {
              let name = entries[i].filename;
              if(name.slice(-4) !== ".nes" && name.slice(-4) !== ".NES") {
                continue;
              }
              found = true;
              log("Loaded \"" + name + "\" from zip");
              entries[i].getData(new zip.BlobWriter(), function(blob) {
                let breader = new FileReader();
                breader.onload = function() {
                  let rbuf = breader.result;
                  let arr = new Uint8Array(rbuf);
                  loadRom(arr, name);
                  reader.close(function() {});
                }
                breader.readAsArrayBuffer(blob);
              }, function(curr, total) {});
              break;
            }
            if(!found) {
              log("No .nes file found in zip");
            }
          } else {
            log("Zip file was empty");
          }
        });
      }, function(err) {
        log("Failed to read zip: " + err);
      });
    } else {
      // load rom normally
      let parts = e.target.value.split("\\");
      let name = parts[parts.length - 1];
      let arr = new Uint8Array(buf);
      loadRom(arr, name);
    }
  }
  freader.readAsArrayBuffer(e.target.files[0]);
}

el("pause").onclick = function(e) {
  if(paused && loaded) {
    resetFrameScheduler();
    loopId = requestAnimationFrame(update);
    audioHandler.start();
    paused = false;
    el("pause").innerText = "Pause";
  } else {
    cancelAnimationFrame(loopId);
    audioHandler.stop();
    paused = true;
    el("pause").innerText = "Unpause";
  }
}

el("reset").onclick = function(e) {
  nes.reset(false);
}

el("hardreset").onclick = function(e) {
  nes.reset(true);
}

el("runframe").onclick = function(e) {
  if(loaded) {
    runFrame();
  }
}

el("fullscreen").onclick = function() {
  if (!document.fullscreenElement) {
    if (screenWrap.requestFullscreen) {
      screenWrap.requestFullscreen().catch(function(err) {
        log("Fullscreen error: " + err.message);
      });
    } else if (screenWrap.webkitRequestFullscreen) {
      screenWrap.webkitRequestFullscreen();
    }
  } else {
    document.exitFullscreen();
  }
};

el("aspect-toggle").onclick = function() {
  if (fsAspectMode === "keep") {
    fsAspectMode = "stretch";
    screenWrap.classList.add("fs-stretch");
    el("aspect-toggle").textContent = "Aspect: Stretch";
  } else {
    fsAspectMode = "keep";
    screenWrap.classList.remove("fs-stretch");
    el("aspect-toggle").textContent = "Aspect: Keep";
  }
  try {
    localStorage.setItem("nesjs_fs_aspect", fsAspectMode);
  } catch(e) {
    log("Could not save aspect preference: " + e);
  }
};

if(touchControllerToggle) {
  touchControllerToggle.onchange = function() {
    touchControllerConfig.enabled = !!touchControllerToggle.checked;
    if(window.TouchControllerConfig) {
      touchControllerConfig = window.TouchControllerConfig.save(touchControllerConfig);
    }
    applyTouchControllerConfig();
    log("Touch controller " + (touchControllerConfig.enabled ? "enabled" : "disabled"));
  };
}

document.onvisibilitychange = function(e) {
  if(document.hidden) {
    pausedInBg = false;
    if(!paused && loaded) {
      el("pause").click();
      pausedInBg = true;
    }
    // Release all gamepad buttons to prevent stuck inputs when tab is hidden
    releaseAllButtonsForPlayer(0);
    releaseAllButtonsForPlayer(1);
    releaseTouchControllerButtons();
  } else {
    if(pausedInBg && loaded) {
      el("pause").click();
      pausedInBg = false;
    }
  }
}

window.onpagehide = function(e) {
  releaseTouchControllerButtons();
  saveBatteryForRom();
}

function loadRom(rom, name) {
  saveBatteryForRom();
  if(nes.loadRom(rom)) {
    // load the roms battery data
    let data = localStorage.getItem(name + "_battery");
    if(data) {
      let obj = JSON.parse(data);
      nes.setBattery(obj);
      log("Loaded battery");
    }
    nes.reset(true);
    if(!loaded && !paused) {
      resetFrameScheduler();
      loopId = requestAnimationFrame(update);
      audioHandler.start();
    }
    loaded = true;
    loadedName = name;
  }
}

function saveBatteryForRom() {
  // save the loadedName's battery data
  if(loaded) {
    let data = nes.getBattery();
    if(data) {
      try {
        localStorage.setItem(loadedName + "_battery", JSON.stringify(data));
        log("Saved battery");
      } catch(e) {
        log("Failed to save battery: " + e);
      }
    }
  }
}

function resetFrameScheduler() {
  lastFrameTime = 0;
  frameDebt = 0;
}

function update(timestamp) {
  loopId = requestAnimationFrame(update);

  if(!lastFrameTime) {
    lastFrameTime = timestamp;
    frameDebt = 0;
  }

  let elapsed = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  frameDebt += elapsed;
  if(frameDebt > MAX_FRAME_DEBT_MS) {
    frameDebt = MAX_FRAME_DEBT_MS;
  }

  pollGamepads();

  let skippedThisCallback = 0;
  while(frameDebt >= NES_FRAME_MS * 2 && skippedThisCallback < MAX_SKIP_FRAMES) {
    runFrameLogic();
    frameDebt -= NES_FRAME_MS;
    skippedThisCallback++;
  }

  if(frameDebt >= NES_FRAME_MS) {
    runFrame();
    frameDebt -= NES_FRAME_MS;
  }
}

function pollGamepads() {
  let gamepads = (navigator.getGamepads && navigator.getGamepads()) || [];
  for(let playerIdx = 0; playerIdx < 2; playerIdx++) {
    let gp = gamepads[playerIdx];
    let player = playerIdx + 1;
    let mapping = gamepadMappings[playerIdx];
    let prev = prevGamepadButtons[playerIdx];

    if(!gp) {
      // Release all buttons if gamepad was previously present
      if(prev.length > 0) {
        for(let btnIdx in mapping.buttons) {
          nes.setButtonReleased(player, nes.INPUT[mapping.buttons[btnIdx]]);
        }
        prevGamepadButtons[playerIdx] = [];
        let axPrev = prevAxisState[playerIdx];
        if(axPrev.left) { nes.setButtonReleased(player, nes.INPUT.LEFT); axPrev.left = false; }
        if(axPrev.right) { nes.setButtonReleased(player, nes.INPUT.RIGHT); axPrev.right = false; }
        if(axPrev.up) { nes.setButtonReleased(player, nes.INPUT.UP); axPrev.up = false; }
        if(axPrev.down) { nes.setButtonReleased(player, nes.INPUT.DOWN); axPrev.down = false; }
      }
      continue;
    }

    if(!gp.buttons || !Array.isArray(gp.buttons)) continue;

    // Digital buttons
    for(let btnIdx in mapping.buttons) {
      let gpBtn = parseInt(btnIdx);
      if(gpBtn >= gp.buttons.length) continue;
      let nesBtn = nes.INPUT[mapping.buttons[btnIdx]];
      let pressed = gp.buttons[gpBtn] ? gp.buttons[gpBtn].pressed : false;
      let wasPrev = !!prev[gpBtn];
      if(pressed && !wasPrev) {
        nes.setButtonPressed(player, nesBtn);
      } else if(!pressed && wasPrev) {
        nes.setButtonReleased(player, nesBtn);
      }
    }

    // Record new button state
    let newPrev = [];
    for(let i = 0; i < gp.buttons.length; i++) {
      newPrev[i] = gp.buttons[i] ? gp.buttons[i].pressed : false;
    }
    prevGamepadButtons[playerIdx] = newPrev;

    // Analog stick axis fallback for D-pad
    let deadzone = clampDeadzone(mapping.axes && mapping.axes.deadzone);
    let axPrev = prevAxisState[playerIdx];
    let axes = gp.axes || [];
    let ax0 = axes[0] || 0;
    let ax1 = axes[1] || 0;

    let nowLeft = ax0 < -deadzone;
    let nowRight = ax0 > deadzone;
    let nowUp = ax1 < -deadzone;
    let nowDown = ax1 > deadzone;

    if(nowLeft && !axPrev.left) { nes.setButtonPressed(player, nes.INPUT.LEFT); }
    else if(!nowLeft && axPrev.left) { nes.setButtonReleased(player, nes.INPUT.LEFT); }

    if(nowRight && !axPrev.right) { nes.setButtonPressed(player, nes.INPUT.RIGHT); }
    else if(!nowRight && axPrev.right) { nes.setButtonReleased(player, nes.INPUT.RIGHT); }

    if(nowUp && !axPrev.up) { nes.setButtonPressed(player, nes.INPUT.UP); }
    else if(!nowUp && axPrev.up) { nes.setButtonReleased(player, nes.INPUT.UP); }

    if(nowDown && !axPrev.down) { nes.setButtonPressed(player, nes.INPUT.DOWN); }
    else if(!nowDown && axPrev.down) { nes.setButtonReleased(player, nes.INPUT.DOWN); }

    axPrev.left = nowLeft;
    axPrev.right = nowRight;
    axPrev.up = nowUp;
    axPrev.down = nowDown;
  }
}

function buildTouchController() {
  if(!touchControllerArea) {
    return;
  }

  touchControllerArea.innerHTML = "";
  TOUCH_CONTROLLER_BUTTONS.forEach(function(buttonName) {
    let button = document.createElement("div");
    let label = buttonName;
    if(buttonName === "SELECT") {
      label = "SEL";
    }
    button.className = "touch-button";
    button.setAttribute("data-button", buttonName);
    button.textContent = label;
    touchControllerArea.appendChild(button);
    touchControllerButtons[buttonName] = button;
  });
}

function applyTouchControllerConfig() {
  if(!screenWrap || !touchControllerArea) {
    return;
  }

  screenWrap.style.setProperty("--touch-controller-window-height", touchControllerConfig.windowedAreaHeight + "px");
  screenWrap.style.setProperty("--touch-controller-fullscreen-height", touchControllerConfig.fullscreenAreaPercent + "vh");
  screenWrap.classList.toggle("touch-controller-enabled", !!touchControllerConfig.enabled);
  touchControllerArea.hidden = !touchControllerConfig.enabled;
  touchControllerArea.setAttribute("aria-hidden", touchControllerConfig.enabled ? "false" : "true");
  if(touchControllerToggle) {
    touchControllerToggle.checked = !!touchControllerConfig.enabled;
  }
  renderTouchControllerButtons();
  if(!touchControllerConfig.enabled) {
    releaseTouchControllerButtons();
  }
}

function renderTouchControllerButtons() {
  for(let buttonName in touchControllerButtons) {
    let button = touchControllerButtons[buttonName];
    let buttonConfig = touchControllerConfig.buttons[buttonName];
    if(!buttonConfig) {
      continue;
    }

    let isPill = buttonName === "SELECT" || buttonName === "START";
    let width = isPill ? Math.round(buttonConfig.size * 1.7) : buttonConfig.size;
    let height = isPill ? Math.max(24, Math.round(buttonConfig.size * 0.68)) : buttonConfig.size;

    button.style.left = buttonConfig.x + "%";
    button.style.top = buttonConfig.y + "%";
    button.style.width = width + "px";
    button.style.height = height + "px";
    button.style.fontSize = Math.max(12, Math.round(height * 0.28)) + "px";
    button.className = "touch-button " +
      (isPill ? "touch-pill" : "touch-round") +
      (buttonName === "UP" || buttonName === "DOWN" || buttonName === "LEFT" || buttonName === "RIGHT" ? " touch-dir" : "");
  }
}

function bindTouchControllerEvents() {
  if(!touchControllerArea) {
    return;
  }

  touchControllerArea.addEventListener("touchstart", handleTouchControllerTouches, false);
  touchControllerArea.addEventListener("touchmove", handleTouchControllerTouches, false);
  touchControllerArea.addEventListener("touchend", handleTouchControllerTouches, false);
  touchControllerArea.addEventListener("touchcancel", handleTouchControllerTouches, false);
}

function handleTouchControllerTouches(e) {
  if(!touchControllerConfig.enabled) {
    return;
  }

  if(e.cancelable) {
    e.preventDefault();
  }

  let nextAssignments = {};
  for(let i = 0; i < e.touches.length; i++) {
    let touch = e.touches[i];
    let buttonName = getTouchControllerButtonAt(touch.clientX, touch.clientY);
    if(buttonName) {
      nextAssignments[touch.identifier] = buttonName;
    }
  }
  syncTouchControllerAssignments(nextAssignments);
}

function getTouchControllerButtonAt(clientX, clientY) {
  let target = document.elementFromPoint(clientX, clientY);
  while(target) {
    if(target.getAttribute && target.getAttribute("data-button")) {
      return target.getAttribute("data-button");
    }
    target = target.parentNode;
  }
  return null;
}

function syncTouchControllerAssignments(nextAssignments) {
  let prevCounts = countTouchControllerAssignments(touchControllerAssignments);
  let nextCounts = countTouchControllerAssignments(nextAssignments);

  TOUCH_CONTROLLER_BUTTONS.forEach(function(buttonName) {
    let hadButton = !!prevCounts[buttonName];
    let hasButton = !!nextCounts[buttonName];
    if(!hadButton && hasButton) {
      nes.setButtonPressed(1, nes.INPUT[buttonName]);
    } else if(hadButton && !hasButton) {
      nes.setButtonReleased(1, nes.INPUT[buttonName]);
    }
    if(touchControllerButtons[buttonName]) {
      touchControllerButtons[buttonName].classList.toggle("pressed", hasButton);
    }
  });

  touchControllerAssignments = nextAssignments;
}

function countTouchControllerAssignments(assignments) {
  let counts = {};
  for(let touchId in assignments) {
    let buttonName = assignments[touchId];
    counts[buttonName] = (counts[buttonName] || 0) + 1;
  }
  return counts;
}

function releaseTouchControllerButtons() {
  touchControllerAssignments = {};
  TOUCH_CONTROLLER_BUTTONS.forEach(function(buttonName) {
    nes.setButtonReleased(1, nes.INPUT[buttonName]);
    if(touchControllerButtons[buttonName]) {
      touchControllerButtons[buttonName].classList.remove("pressed");
    }
  });
}

function runFrameLogic() {
  nes.runFrame();
  nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
  audioHandler.nextBuffer();
}

function renderFrame() {
  nes.getPixels(imgData.data);
  ctx.putImageData(imgData, 0, 0);
}

function runFrame() {
  runFrameLogic();
  renderFrame();
}

function log(text) {
  el("log").innerHTML += text + "<br>";
  el("log").scrollTop = el("log").scrollHeight;
}

function el(id) {
  return document.getElementById(id);
}

// Truncate long gamepad names for display: max 40 chars shown (37 + "...")
const MAX_GAMEPAD_NAME_LENGTH = 40;
const GAMEPAD_NAME_TRUNCATE_LENGTH = 37;

document.addEventListener("fullscreenchange", function() {
  isFullscreen = !!document.fullscreenElement;
  el("fullscreen").textContent = isFullscreen ? "⛶ Exit Fullscreen" : "⛶ Fullscreen";
});

window.addEventListener("gamepadconnected", function(e) {
  let playerIdx = e.gamepad.index;
  if(playerIdx < 2) {
    let id = e.gamepad.id;
    let label = id.length > MAX_GAMEPAD_NAME_LENGTH
      ? id.slice(0, GAMEPAD_NAME_TRUNCATE_LENGTH) + "..."
      : id;
    log("🎮 P" + (playerIdx + 1) + " gamepad connected: " + label);
    updateGamepadStatus(playerIdx, label);
  }
});

window.addEventListener("gamepaddisconnected", function(e) {
  let playerIdx = e.gamepad.index;
  if(playerIdx < 2) {
    log("🎮 P" + (playerIdx + 1) + " gamepad disconnected");
    releaseAllButtonsForPlayer(playerIdx);
    updateGamepadStatus(playerIdx, null);
  }
});

function updateGamepadStatus(playerIdx, label) {
  let statusEl = el("gp-status-" + (playerIdx + 1));
  if(statusEl) {
    statusEl.textContent = label ? "Connected: " + label : "Disconnected";
    statusEl.className = "gp-status " + (label ? "gp-connected" : "gp-disconnected");
  }
}

window.onkeydown = function(e) {
  if(controlsP1[e.key.toLowerCase()] !== undefined) {
    nes.setButtonPressed(1, controlsP1[e.key.toLowerCase()]);
    e.preventDefault();
  }
  if(controlsP2[e.key.toLowerCase()] !== undefined) {
    nes.setButtonPressed(2, controlsP2[e.key.toLowerCase()]);
    e.preventDefault();
  }
}

window.onkeyup = function(e) {
  if(controlsP1[e.key.toLowerCase()] !== undefined) {
    nes.setButtonReleased(1, controlsP1[e.key.toLowerCase()]);
    e.preventDefault();
  }
  if(controlsP2[e.key.toLowerCase()] !== undefined) {
    nes.setButtonReleased(2, controlsP2[e.key.toLowerCase()]);
    e.preventDefault();
  }
  if(e.key.toLowerCase() === "m" && loaded) {
    let saveState = nes.getState();
    try {
      localStorage.setItem(loadedName + "_savestate", JSON.stringify(saveState));
      log("Saved state");
    } catch(e) {
      log("Failed to save state: " + e);
    }
  }
  if(e.key.toLowerCase() === "n" && loaded) {
    let data = localStorage.getItem(loadedName + "_savestate");
    if(data) {
      let obj = JSON.parse(data);
      if(nes.setState(obj)) {
        log("Loaded state");
      } else {
        log("Failed to load state");
      }
    } else {
      log("No state saved yet");
    }
  }
}
