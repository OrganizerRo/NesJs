# Fullscreen Support Plan for NesJs

Repository: `OrganizerRo/NesJs`

---

## Overview

Add fullscreen support for the NES canvas in `index.html`, using the browser's native
[Fullscreen API](https://developer.mozilla.org/en-US/docs/Web/API/Fullscreen_API).
The feature must:

- Enter fullscreen via a **"Fullscreen" button** or **double-clicking** the canvas.
- Support two scaling modes selectable before or after entering fullscreen:
  - **Keep aspect ratio** – black bars fill the remaining screen space (letterbox/pillarbox).
  - **Stretch** – the canvas fills the entire screen regardless of proportions.
- Exit fullscreen with the **Esc** key (browser handles this natively) **or** by **left-clicking** the canvas while in fullscreen.
- Save the chosen scaling mode preference to `localStorage` so it persists across sessions.

The debugger page (`debug.html` / `js/dbmain.js`) is **out of scope** for this initial
implementation; the same approach can be applied there later.

---

## Affected Files

| File | Change type |
|---|---|
| `index.html` | Add fullscreen button, aspect-ratio toggle button, and a wrapper `<div>` around the canvas |
| `style.css` | Add fullscreen CSS rules for both scaling modes and transition polish |
| `js/main.js` | Add fullscreen entry/exit logic, keyboard hook, click-to-exit listener, preference persistence |

No new files need to be created; no NES emulation files (`nes/`, `mappers/`, `js/audio.js`, etc.) are touched.

---

## Detailed Implementation

### 1. `index.html` — Structure changes

**Location:** lines 8–18 (the controls and canvas area).

#### 1a. Wrap the canvas in a container `<div>`

The Fullscreen API can be invoked on any DOM element. Wrapping the canvas in a
`<div id="screen-wrap">` lets us fullscreen the wrapper instead of the bare `<canvas>`.
This gives a black background by default and makes centering / letterboxing straightforward
with CSS flexbox.

```html
<!-- Replace the bare <canvas id="output"></canvas> line with: -->
<div id="screen-wrap">
  <canvas id="output"></canvas>
</div>
```

#### 1b. Add UI buttons

Insert two buttons directly above (or below) the `<canvas>` line, keeping them adjacent
to the existing control buttons:

```html
<button id="fullscreen">⛶ Fullscreen</button>
<button id="aspect-toggle">Aspect: Keep</button>
```

- `#fullscreen` — enters/exits fullscreen.
- `#aspect-toggle` — cycles between **Keep** and **Stretch**; its label reflects the active mode.

---

### 2. `style.css` — CSS changes

**Location:** after the existing `#output` block (currently lines 24–29).

#### 2a. Screen wrapper — normal (windowed) state

```css
#screen-wrap {
  display: inline-block;   /* shrink-wraps to the canvas in windowed mode */
}
```

#### 2b. Canvas — fullscreen state, keep-aspect-ratio mode

When `#screen-wrap` is the fullscreen element the browser applies the
`:-webkit-full-screen` / `:fullscreen` pseudo-class to it.

```css
#screen-wrap:fullscreen {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: #000;
}

/* Keep aspect ratio: scale canvas as large as possible without distortion */
#screen-wrap:fullscreen #output {
  width: auto;
  height: auto;
  max-width: 100%;
  max-height: 100%;
  /* preserve the pixelated look */
  image-rendering: crisp-edges;
  image-rendering: pixelated;
}

/* Stretch mode: canvas fills the entire screen */
#screen-wrap.fs-stretch:fullscreen #output {
  width: 100%;
  height: 100%;
}
```

The `.fs-stretch` class is toggled by JavaScript on `#screen-wrap`.  
Both vendor-prefixed (`::-webkit-full-screen`) and standard (`:fullscreen`) selectors
should be included to cover all major browsers.

#### 2c. Optional cursor hiding when fullscreen

```css
#screen-wrap:fullscreen {
  cursor: none;
}
```

Remove or adjust this if a visible cursor is preferred.

---

### 3. `js/main.js` — JavaScript changes

#### 3a. State variables

**Location:** top of file, after the existing state declarations (after line 8).

```js
let isFullscreen = false;
// Scaling preference: "keep" | "stretch"
let fsAspectMode = localStorage.getItem("nesjs_fs_aspect") || "keep";
```

#### 3b. Helper references

**Location:** after the `el("output")` canvas setup (after line 13).

```js
let screenWrap = el("screen-wrap");
```

Apply the persisted stretch class immediately on page load:

```js
if (fsAspectMode === "stretch") {
  screenWrap.classList.add("fs-stretch");
}
```

#### 3c. Initialise the aspect-toggle button label on load

```js
el("aspect-toggle").textContent = "Aspect: " + (fsAspectMode === "stretch" ? "Stretch" : "Keep");
```

#### 3d. `#fullscreen` button click handler

**Location:** alongside the other `el("...").onclick` handlers (around line 170).

```js
el("fullscreen").onclick = function() {
  if (!document.fullscreenElement) {
    screenWrap.requestFullscreen().catch(function(err) {
      log("Fullscreen error: " + err.message);
    });
  } else {
    document.exitFullscreen();
  }
};
```

#### 3e. `#aspect-toggle` button click handler

```js
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
```

#### 3f. `fullscreenchange` event — track state and update button label

**Location:** with the other `window.addEventListener` calls (around line 360).

```js
document.addEventListener("fullscreenchange", function() {
  isFullscreen = !!document.fullscreenElement;
  el("fullscreen").textContent = isFullscreen ? "⛶ Exit Fullscreen" : "⛶ Fullscreen";
});
```

#### 3g. Left-click on canvas to exit fullscreen

**Location:** after the canvas is referenced (after line 13).

```js
c.addEventListener("click", function() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  }
});
```

> **Note:** This listener is intentionally on the `<canvas>` element (`c`), not the wrapper,
> so that clicking the black letterbox bars does **not** exit fullscreen — only clicking
> the active game image does.

#### 3h. Esc key handling

The browser's Fullscreen API already exits fullscreen when Esc is pressed and fires
`fullscreenchange`. The existing `window.onkeydown` handler (line 389) does **not** need
modification — Esc is not mapped to any NES button, so it naturally falls through.

However, we should ensure the Esc key's `e.preventDefault()` is **not** called in
`window.onkeydown`, which is already the case (the existing code only calls
`preventDefault()` when a NES button mapping is matched).

---

## Data Flow Summary

```
User action
    │
    ├─ Double-click canvas  ──────────────────────────────┐
    ├─ Click "⛶ Fullscreen" button                       │
    │                                                     ▼
    │                                          screenWrap.requestFullscreen()
    │                                                     │
    │                                          fullscreenchange event fires
    │                                          isFullscreen = true
    │                                          Button label → "⛶ Exit Fullscreen"
    │
    ├─ Press Esc (while fullscreen) ──────────────────────┐
    ├─ Left-click canvas (while fullscreen)               │
    ├─ Click "⛶ Exit Fullscreen" button                  │
    │                                                     ▼
    │                                          document.exitFullscreen()
    │                                                     │
    │                                          fullscreenchange event fires
    │                                          isFullscreen = false
    │                                          Button label → "⛶ Fullscreen"
    │
    └─ Click "Aspect: Keep/Stretch" ──────────────────────►  Toggle .fs-stretch class
                                                              Save to localStorage
```

---

## Browser Compatibility Notes

| Browser | Fullscreen API | Notes |
|---|---|---|
| Chrome 71+ | `requestFullscreen()` | Standard |
| Firefox 64+ | `requestFullscreen()` | Standard |
| Safari 16.4+ | `requestFullscreen()` | Requires `webkit` prefix for older versions |
| Edge 79+ | `requestFullscreen()` | Standard |

For maximum Safari compatibility, add the webkit-prefixed call as a fallback:

```js
// In the fullscreen enter block:
if (screenWrap.requestFullscreen) {
  screenWrap.requestFullscreen();
} else if (screenWrap.webkitRequestFullscreen) {
  screenWrap.webkitRequestFullscreen();
}
```

Similarly for CSS:

```css
#screen-wrap:-webkit-full-screen { /* ... same rules as :fullscreen ... */ }
#screen-wrap:-webkit-full-screen #output { /* ... */ }
#screen-wrap.fs-stretch:-webkit-full-screen #output { /* ... */ }
```

---

## Implementation Checklist

- [ ] **`index.html`**: Wrap `<canvas id="output">` in `<div id="screen-wrap">`.
- [ ] **`index.html`**: Add `<button id="fullscreen">` and `<button id="aspect-toggle">`.
- [ ] **`style.css`**: Add `#screen-wrap` windowed base style.
- [ ] **`style.css`**: Add `:fullscreen` rules for keep-aspect and stretch modes (including `-webkit-` prefix variants).
- [ ] **`js/main.js`**: Declare `isFullscreen` and `fsAspectMode` state variables.
- [ ] **`js/main.js`**: Reference `screenWrap` and apply persisted stretch class on load.
- [ ] **`js/main.js`**: Wire up `#fullscreen` button `onclick`.
- [ ] **`js/main.js`**: Wire up `#aspect-toggle` button `onclick` with localStorage persistence.
- [ ] **`js/main.js`**: Add `document.addEventListener("fullscreenchange", ...)` handler.
- [ ] **`js/main.js`**: Add canvas `click` listener to exit fullscreen.
- [ ] **Verify**: Esc key exits fullscreen (browser-native, no code change needed).

---

## Verification / Test Plan

### Manual test steps

#### Entering fullscreen

| # | Action | Expected result |
|---|---|---|
| 1 | Load a ROM so the emulator is running | Canvas shows gameplay |
| 2 | Click the **"⛶ Fullscreen"** button | Browser enters fullscreen; canvas fills the screen with black bars (keep-aspect default) |
| 3 | Confirm button label changed to **"⛶ Exit Fullscreen"** | ✓ |
| 4 | Confirm NES gameplay continues uninterrupted | ✓ |

#### Exiting fullscreen — Esc key

| # | Action | Expected result |
|---|---|---|
| 5 | While in fullscreen, press **Esc** | Fullscreen is exited; page returns to windowed view |
| 6 | Button label reverts to **"⛶ Fullscreen"** | ✓ |
| 7 | Canvas still shows gameplay at its normal 512×480 CSS size | ✓ |

#### Exiting fullscreen — canvas click

| # | Action | Expected result |
|---|---|---|
| 8 | Re-enter fullscreen (step 2) | ✓ |
| 9 | Left-click anywhere on the game canvas (not the black bars) | Fullscreen exits; windowed view restored |
| 10 | Confirm gameplay did **not** toggle a NES button (no accidental input) | ✓ |

#### Aspect ratio — keep (default)

| # | Action | Expected result |
|---|---|---|
| 11 | With **Aspect: Keep** active, enter fullscreen on a widescreen monitor | Black pillarbox bars visible on left/right; canvas maintains NES 8:7 ratio |
| 12 | On a 4:3 monitor / narrow window (DevTools device emulation) | Bars appear on top/bottom instead |

#### Aspect ratio — stretch

| # | Action | Expected result |
|---|---|---|
| 13 | Click **"Aspect: Keep"** button to toggle to **"Aspect: Stretch"** | Button label changes to **"Aspect: Stretch"** |
| 14 | Enter fullscreen | Canvas stretches to fill the entire screen with no bars |
| 15 | Exit and re-enter fullscreen | Stretch mode persists |
| 16 | Reload the page | Stretch mode is remembered (loaded from `localStorage`) |

#### Toggle button outside fullscreen

| # | Action | Expected result |
|---|---|---|
| 17 | Toggle aspect mode while **not** in fullscreen | Button label updates; class is set correctly; no visual change in windowed view (expected) |
| 18 | Enter fullscreen after toggling | Correct mode immediately applied |

#### Keyboard controls during fullscreen

| # | Action | Expected result |
|---|---|---|
| 19 | Press arrow keys / Z / A / Enter during fullscreen | NES buttons respond normally |
| 20 | Press **M** (save state) / **N** (load state) during fullscreen | Save/load still works |

#### Safari / older browser fallback

| # | Action | Expected result |
|---|---|---|
| 21 | Open in Safari (or any browser supporting only `webkitRequestFullscreen`) | Fullscreen still enters correctly via prefixed API |

### Automated / DevTools checks

- Open **DevTools → Elements** while in fullscreen and confirm `#screen-wrap` has the
  `:fullscreen` pseudo-class applied.
- Open **DevTools → Application → Local Storage** and confirm `nesjs_fs_aspect` is
  saved as `"stretch"` after toggling to stretch mode.
- Use **DevTools → Device toolbar** to emulate a phone screen; confirm aspect-ratio mode
  letterboxes correctly at the device's aspect ratio.

---

## Out of Scope

- Debugger page (`debug.html` / `js/dbmain.js`) — same approach applies but is a
  separate change.
- Gamepad vibration or any other input changes.
- Changing the NES internal resolution (`256×240`).
