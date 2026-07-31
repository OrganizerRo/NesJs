(function(window) {
  const COOKIE_KEY = "nesjs_touch_controller";
  const BUTTON_ORDER = ["UP", "DOWN", "LEFT", "RIGHT", "SELECT", "EXIT", "START", "B", "A"];
  const BUTTON_NAME_MAP = {
    up: "UP",
    down: "DOWN",
    left: "LEFT",
    right: "RIGHT",
    select: "SELECT",
    exit: "EXIT",
    exitfullscreen: "EXIT",
    exit_fullscreen: "EXIT",
    start: "START",
    b: "B",
    a: "A"
  };
  const DEFAULT_CONFIG = {
    enabled: false,
    windowedAreaHeight: 180,
    fullscreenAreaPercent: 30,
    buttons: {
      UP: { x: 22, y: 28, size: 52 },
      DOWN: { x: 22, y: 72, size: 52 },
      LEFT: { x: 10, y: 50, size: 52 },
      RIGHT: { x: 34, y: 50, size: 52 },
      SELECT: { x: 50, y: 70, size: 44 },
      EXIT: { x: 56, y: 70, size: 28 },
      START: { x: 63, y: 70, size: 44 },
      B: { x: 78, y: 52, size: 58 },
      A: { x: 91, y: 36, size: 58 }
    }
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clampNumber(value, min, max, fallback) {
    let num = Number(value);
    if(!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, num));
  }

  function normalizeButtonName(name) {
    if(typeof name !== "string") {
      return null;
    }
    let upper = name.toUpperCase();
    if(BUTTON_ORDER.indexOf(upper) !== -1) {
      return upper;
    }
    return BUTTON_NAME_MAP[name.toLowerCase()] || null;
  }

  function sanitizeButtonConfig(buttonConfig, fallback) {
    fallback = fallback || { x: 50, y: 50, size: 48 };
    if(!buttonConfig || typeof buttonConfig !== "object") {
      return clone(fallback);
    }
    return {
      x: clampNumber(buttonConfig.x, 0, 100, fallback.x),
      y: clampNumber(buttonConfig.y, 0, 100, fallback.y),
      size: clampNumber(buttonConfig.size, 28, 120, fallback.size)
    };
  }

  function sanitizeTouchControllerConfig(rawConfig) {
    let config = clone(DEFAULT_CONFIG);
    if(!rawConfig || typeof rawConfig !== "object") {
      return config;
    }

    config.enabled = !!rawConfig.enabled;
    config.windowedAreaHeight = clampNumber(rawConfig.windowedAreaHeight, 80, 320, DEFAULT_CONFIG.windowedAreaHeight);
    config.fullscreenAreaPercent = clampNumber(rawConfig.fullscreenAreaPercent, 10, 50, DEFAULT_CONFIG.fullscreenAreaPercent);

    if(rawConfig.buttons && typeof rawConfig.buttons === "object") {
      for(let buttonKey in rawConfig.buttons) {
        let normalized = normalizeButtonName(buttonKey);
        if(!normalized) {
          continue;
        }
        config.buttons[normalized] = sanitizeButtonConfig(rawConfig.buttons[buttonKey], DEFAULT_CONFIG.buttons[normalized]);
      }
    }

    return config;
  }

  function getCookie(name) {
    let prefix = name + "=";
    let cookies = document.cookie ? document.cookie.split(";") : [];
    for(let i = 0; i < cookies.length; i++) {
      let cookie = cookies[i].trim();
      if(cookie.indexOf(prefix) === 0) {
        return decodeURIComponent(cookie.slice(prefix.length));
      }
    }
    return "";
  }

  function loadTouchControllerConfig() {
    let rawCookie = getCookie(COOKIE_KEY);
    if(!rawCookie) {
      return clone(DEFAULT_CONFIG);
    }
    try {
      return sanitizeTouchControllerConfig(JSON.parse(rawCookie));
    } catch(e) {
      console.warn("[touch-controller] Failed to parse cookie, using defaults.", e);
      return clone(DEFAULT_CONFIG);
    }
  }

  function saveTouchControllerConfig(config) {
    let sanitized = sanitizeTouchControllerConfig(config);
    document.cookie = COOKIE_KEY + "=" + encodeURIComponent(JSON.stringify(sanitized)) +
      "; path=/; max-age=" + (60 * 60 * 24 * 365 * 5) + "; SameSite=Lax";
    return sanitized;
  }

  function parseImportedTouchControllerConfig(text) {
    return sanitizeTouchControllerConfig(JSON.parse(text));
  }

  window.TouchControllerConfig = {
    BUTTON_ORDER: BUTTON_ORDER.slice(),
    COOKIE_KEY: COOKIE_KEY,
    cloneDefaults: function() {
      return clone(DEFAULT_CONFIG);
    },
    load: loadTouchControllerConfig,
    save: saveTouchControllerConfig,
    sanitize: sanitizeTouchControllerConfig,
    parseImported: parseImportedTouchControllerConfig
  };
})(window);
