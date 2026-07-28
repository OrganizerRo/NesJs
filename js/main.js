
let nes = new Nes();
let audioHandler = new AudioHandler();
let paused = false;
let loaded = false;
let pausedInBg = false;
let loopId = 0;
let loadedName = "";

let c = el("output");
c.width = 256;
c.height = 240;
let ctx = c.getContext("2d");
let imgData = ctx.createImageData(256, 240);

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

// Default gamepad mappings (Standard Gamepad layout)
const DEFAULT_GAMEPAD_MAPPING = {
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

let gamepadMappings = [
  JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPING)),
  JSON.parse(JSON.stringify(DEFAULT_GAMEPAD_MAPPING))
];

// Try loading saved mappings from localStorage
(function() {
  try {
    let saved = localStorage.getItem("nesjs_gamepad_mappings");
    if(saved) {
      let parsed = JSON.parse(saved);
      if(Array.isArray(parsed) && parsed.length === 2 &&
         parsed[0].buttons && parsed[0].axes && parsed[1].buttons && parsed[1].axes) {
        gamepadMappings = parsed;
      }
    }
  } catch(e) {
    // ignore, use defaults
  }
})();

// Per-player previous button state for transition detection
let prevGamepadButtons = [[], []];
// Per-player previous axis-synthesized direction state
let prevAxisState = [
  { left: false, right: false, up: false, down: false },
  { left: false, right: false, up: false, down: false }
];

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

document.onvisibilitychange = function(e) {
  if(document.hidden) {
    pausedInBg = false;
    if(!paused && loaded) {
      el("pause").click();
      pausedInBg = true;
    }
  } else {
    if(pausedInBg && loaded) {
      el("pause").click();
      pausedInBg = false;
    }
  }
}

window.onpagehide = function(e) {
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

function update() {
  runFrame();
  loopId = requestAnimationFrame(update);
}

function pollGamepads() {
  let gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  for(let playerIdx = 0; playerIdx < 2; playerIdx++) {
    let gp = gamepads[playerIdx];
    let player = playerIdx + 1;
    let mapping = gamepadMappings[playerIdx];
    let prev = prevGamepadButtons[playerIdx];

    if(!gp) {
      // release all buttons if gamepad was previously present
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

    // Digital buttons
    for(let btnIdx in mapping.buttons) {
      let gpBtn = parseInt(btnIdx);
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
    let deadzone = mapping.axes.deadzone;
    let axPrev = prevAxisState[playerIdx];
    let ax0 = gp.axes[0] || 0;
    let ax1 = gp.axes[1] || 0;

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

function runFrame() {
  pollGamepads();
  nes.runFrame();
  nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
  audioHandler.nextBuffer();
  nes.getPixels(imgData.data);
  ctx.putImageData(imgData, 0, 0);
}

function log(text) {
  el("log").innerHTML += text + "<br>";
  el("log").scrollTop = el("log").scrollHeight;
}

function el(id) {
  return document.getElementById(id);
}

const MAX_GAMEPAD_NAME_LENGTH = 40;
const GAMEPAD_NAME_TRUNCATE_LENGTH = 37;

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
    prevGamepadButtons[playerIdx] = [];
    prevAxisState[playerIdx] = { left: false, right: false, up: false, down: false };
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
