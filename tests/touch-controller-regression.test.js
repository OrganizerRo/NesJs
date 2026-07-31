const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const touchConfigPath = path.join(repoRoot, "js", "touchcontroller-config.js");
const mainJsPath = path.join(repoRoot, "js", "main.js");

function createCookieDocument(initialCookies) {
  const jar = Object.assign({}, initialCookies || {});
  return {
    get cookie() {
      return Object.keys(jar).map(function(key) {
        return key + "=" + jar[key];
      }).join("; ");
    },
    set cookie(value) {
      const pair = String(value || "").split(";")[0];
      const idx = pair.indexOf("=");
      if(idx === -1) {
        return;
      }
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1);
      jar[key] = val;
    }
  };
}

function createLocalStorage(options) {
  const data = {};
  const shouldThrow = options && options.throwOnAccess;
  return {
    getItem(key) {
      if(shouldThrow) {
        throw new Error("localStorage unavailable");
      }
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      if(shouldThrow) {
        throw new Error("localStorage unavailable");
      }
      data[key] = String(value);
    },
    _data: data
  };
}

function loadApi(opts) {
  const document = createCookieDocument((opts && opts.initialCookies) || {});
  const localStorage = (opts && opts.localStorage) || createLocalStorage();
  const windowObj = { localStorage: localStorage };
  const context = vm.createContext({
    window: windowObj,
    document: document,
    console: {
      warn: function() {},
      log: function() {},
      error: function() {}
    }
  });
  const source = fs.readFileSync(touchConfigPath, "utf8");
  vm.runInContext(source, context, { filename: touchConfigPath });
  return {
    api: windowObj.TouchControllerConfig,
    document: document,
    localStorage: localStorage
  };
}

function testSaveAndLoadFromLocalStorage() {
  const loaded = loadApi();
  const api = loaded.api;
  const next = api.cloneDefaults();
  next.enabled = true;
  next.windowedAreaHeight = 214;
  next.fullscreenAreaPercent = 41;
  next.buttons.START.x = 77;
  api.save(next);

  loaded.document.cookie = "nesjs_touch_controller=" + encodeURIComponent(JSON.stringify({
    enabled: false,
    windowedAreaHeight: 180,
    fullscreenAreaPercent: 30,
    buttons: {}
  }));
  const reloaded = api.load();
  assert.strictEqual(reloaded.enabled, true);
  assert.strictEqual(reloaded.windowedAreaHeight, 214);
  assert.strictEqual(reloaded.fullscreenAreaPercent, 41);
  assert.strictEqual(reloaded.buttons.START.x, 77);
}

function testLoadFallsBackToCookieWhenStorageUnavailable() {
  const config = {
    enabled: true,
    windowedAreaHeight: 200,
    fullscreenAreaPercent: 40,
    buttons: { START: { x: 66, y: 55, size: 61 } }
  };
  const cookieValue = encodeURIComponent(JSON.stringify(config));
  const loaded = loadApi({
    initialCookies: { nesjs_touch_controller: cookieValue },
    localStorage: createLocalStorage({ throwOnAccess: true })
  });

  const read = loaded.api.load();
  assert.strictEqual(read.enabled, true);
  assert.strictEqual(read.windowedAreaHeight, 200);
  assert.strictEqual(read.fullscreenAreaPercent, 40);
  assert.strictEqual(read.buttons.START.x, 66);
}

function testMalformedStorageFallsBackToCookie() {
  const localStorage = createLocalStorage();
  localStorage.setItem("nesjs_touch_controller", "{bad json");
  const config = {
    enabled: true,
    windowedAreaHeight: 180,
    fullscreenAreaPercent: 33,
    buttons: { A: { x: 88, y: 44, size: 59 } }
  };
  const cookieValue = encodeURIComponent(JSON.stringify(config));
  const loaded = loadApi({
    initialCookies: { nesjs_touch_controller: cookieValue },
    localStorage: localStorage
  });
  const read = loaded.api.load();
  assert.strictEqual(read.enabled, true);
  assert.strictEqual(read.fullscreenAreaPercent, 33);
  assert.strictEqual(read.buttons.A.size, 59);
}

function testSanitizationAndAliases() {
  const loaded = loadApi();
  const sanitized = loaded.api.sanitize({
    enabled: 1,
    windowedAreaHeight: 999,
    fullscreenAreaPercent: -5,
    buttons: {
      start: { x: 150, y: -10, size: 4 },
      exit_fullscreen: { x: 25, y: 20, size: 26 }
    }
  });
  assert.strictEqual(sanitized.enabled, true);
  assert.strictEqual(sanitized.windowedAreaHeight, 320);
  assert.strictEqual(sanitized.fullscreenAreaPercent, 10);
  assert.strictEqual(sanitized.buttons.START.x, 100);
  assert.strictEqual(sanitized.buttons.START.y, 0);
  assert.strictEqual(sanitized.buttons.START.size, 28);
  assert.strictEqual(sanitized.buttons.EXIT.size, 28);
}

function testMainIncludesPointerAndTouchSupport() {
  const source = fs.readFileSync(mainJsPath, "utf8");
  ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerleave"].forEach(function(evt) {
    assert(source.includes('addEventListener("' + evt + '"'), "Missing pointer listener: " + evt);
  });
  assert(source.includes('addEventListener("touchstart"'), "Missing touchstart handler");
  assert(source.includes("function handleTouchControllerPointer"), "Missing pointer handler");
}

testSaveAndLoadFromLocalStorage();
testLoadFallsBackToCookieWhenStorageUnavailable();
testMalformedStorageFallsBackToCookie();
testSanitizationAndAliases();
testMainIncludesPointerAndTouchSupport();

console.log("touch-controller-regression.test.js: all tests passed");
