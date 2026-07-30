# Drop NES Rendered Frames on Slow Machines

## Goal and Scope

### Goal
Keep emulation running at NES time on slower machines by **skipping expensive video renders when the browser falls behind real time**, instead of slowing the entire game down.

Today `js/main.js` runs exactly one emulated frame per `requestAnimationFrame` callback:

```js
function update() {
  runFrame();
  loopId = requestAnimationFrame(update);
}
```

That means the emulator speed is directly tied to how quickly the browser can finish one callback. If a callback takes longer than one display frame (~16.6 ms), the emulator simply runs slower than real hardware.

The desired behavior is:
- always advance **NES logic/audio** at the correct rate when possible
- drop some **browser renders** when necessary
- recover gradually when briefly behind
- avoid an unbounded catch-up loop

### In Scope
- `requestAnimationFrame(timestamp)`-based frame pacing in `js/main.js`
- tracking real-time drift with `lastFrameTime` and `frameDebt`
- running extra emulation frames without calling `getPixels()` / `putImageData()`
- clamping catch-up work with a max skip limit
- handling pause/unpause and tab hide/show safely

### Out of Scope
- changing emulator core timing inside `nes.runFrame()`
- changing PPU/APU/CPU cycle accounting
- rewriting audio buffering strategy
- adding workers, threaded rendering, or offscreen canvas
- tuning unrelated performance issues elsewhere in the emulator
- changing ROM loading, save states, input mapping, or debugger behavior except where timing state must be reset

---

## Why Frame Skipping Is the Right Fix

`nes.runFrame()` already advances one full NES frame of CPU/PPU/APU work. The expensive part outside the core is the browser-side render path:

```js
nes.getPixels(imgData.data);
ctx.putImageData(imgData, 0, 0);
```

When the machine is slow, rendering every emulated frame is less important than keeping gameplay speed and audio timing close to real hardware. Skipping a rendered frame is visually acceptable; slowing all game logic is not.

This is the same trade-off many emulators use: **preserve time accuracy first, visual completeness second**.

---

## Proposed Approach

### Timing Model
Use the `DOMHighResTimeStamp` passed into `requestAnimationFrame(update)` as the source of real elapsed time.

Track two values:
- `lastFrameTime`: the previous RAF timestamp
- `frameDebt`: accumulated milliseconds of NES time that still need to be simulated

Per callback:
1. compute `elapsed = timestamp - lastFrameTime`
2. add `elapsed` to `frameDebt`
3. clamp `frameDebt` so a huge stall does not create an enormous recovery burst
4. run zero or more **logic-only** frames while `frameDebt >= NES_FRAME_MS`, up to `MAX_SKIP_FRAMES`
5. run one final **full** frame (logic + render) when enough debt remains, then subtract one frame of debt
6. request the next RAF

### Core Catch-up Loop
Preferred behavior:

```js
elapsed = timestamp - lastFrameTime;
lastFrameTime = timestamp;
frameDebt += elapsed;
frameDebt = Math.min(frameDebt, MAX_FRAME_DEBT_MS);

pollGamepads();

let skippedThisCallback = 0;
while(frameDebt >= NES_FRAME_MS && skippedThisCallback < MAX_SKIP_FRAMES) {
  runFrameLogic(); // CPU + PPU + APU + audio samples
  frameDebt -= NES_FRAME_MS;
  skippedThisCallback++;
}

if(frameDebt >= NES_FRAME_MS) {
  runFrame(); // logic + render
  frameDebt -= NES_FRAME_MS;
} else {
  renderCurrentFrame(); // optional fallback if preserving latest pixels is desired
}
```

### Important Behavioral Detail
The skipped frames must still run:
- `nes.runFrame()`
- `nes.getSamples(...)`
- `audioHandler.nextBuffer()`

They must **not** run:
- `nes.getPixels(...)`
- `ctx.putImageData(...)`

That preserves emulator time and audio progression while dropping only the most expensive browser-visible work.

---

## Preferred Structure in `js/main.js`

### Option A: Split Logic and Render (recommended)
Refactor the current `runFrame()` into three responsibilities:

```js
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
```

Then move `pollGamepads()` into `update(timestamp)` so inputs are read once per browser callback, not once per skipped frame.

Why this is better:
- clearer separation between emulation and presentation
- avoids re-polling gamepads several times inside one RAF callback
- makes the skip loop explicit and easy to reason about
- keeps the rendered frame path identical to today

### Option B: Add a `skipRender` Parameter
Alternative minimal diff:

```js
function runFrame(skipRender = false) {
  nes.runFrame();
  nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
  audioHandler.nextBuffer();
  if(!skipRender) {
    nes.getPixels(imgData.data);
    ctx.putImageData(imgData, 0, 0);
  }
}
```

Then the catch-up loop calls `runFrame(true)` and the visible frame calls `runFrame(false)`.

This is valid, but Option A is cleaner and easier to extend.

---

## Constants Needed

### `NES_FRAME_MS`
Use the NES frame duration in milliseconds:

```js
const NES_FRAME_MS = 1000 / 60.0988; // ≈ 16.639 ms
```

Document it as “one NTSC NES frame of emulated time.”

### `MAX_SKIP_FRAMES`
Use:

```js
const MAX_SKIP_FRAMES = 4;
```

Rationale:
- enough to recover from brief slowdowns
- prevents one RAF callback from monopolizing the main thread
- reduces risk of a feedback loop where catch-up work itself causes more lateness
- still allows substantial recovery: up to 5 total emulated frames in one callback if the final rendered frame also runs

### `MAX_FRAME_DEBT_MS`
Add an explicit clamp for very large gaps:

```js
const MAX_FRAME_DEBT_MS = NES_FRAME_MS * (MAX_SKIP_FRAMES + 1);
```

or slightly larger if desired.

Rationale:
- tab resume, breakpoint pauses, or GC stalls can produce hundreds or thousands of ms of elapsed time
- trying to simulate all of that in one burst is both pointless and user-visible
- clamping drops old debt and resumes from “now” instead of attempting impossible catch-up

---

## Exact Code Changes Needed in `js/main.js`

## 1) Add timing constants and state near the existing top-level loop state
Current top-level state already includes:
- `paused`
- `loaded`
- `pausedInBg`
- `loopId`

Add:

```js
const NES_FRAME_MS = 1000 / 60.0988;
const MAX_SKIP_FRAMES = 4;
const MAX_FRAME_DEBT_MS = NES_FRAME_MS * (MAX_SKIP_FRAMES + 1);

let lastFrameTime = 0;
let frameDebt = 0;
```

## 2) Split `runFrame()`
Current implementation:

```js
function runFrame() {
  pollGamepads();
  nes.runFrame();
  nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
  audioHandler.nextBuffer();
  nes.getPixels(imgData.data);
  ctx.putImageData(imgData, 0, 0);
}
```

Recommended new layout:

```js
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
```

And then call `pollGamepads()` from `update(timestamp)` before any catch-up work.

## 3) Rewrite `update()` to accept the RAF timestamp
Current:

```js
function update() {
  runFrame();
  loopId = requestAnimationFrame(update);
}
```

Proposed structure:

```js
function update(timestamp) {
  if(!lastFrameTime) {
    lastFrameTime = timestamp;
  }

  let elapsed = timestamp - lastFrameTime;
  lastFrameTime = timestamp;

  frameDebt += elapsed;
  if(frameDebt > MAX_FRAME_DEBT_MS) {
    frameDebt = MAX_FRAME_DEBT_MS;
  }

  pollGamepads();

  let skippedThisCallback = 0;
  while(frameDebt >= NES_FRAME_MS && skippedThisCallback < MAX_SKIP_FRAMES) {
    runFrameLogic();
    frameDebt -= NES_FRAME_MS;
    skippedThisCallback++;
  }

  if(frameDebt >= NES_FRAME_MS) {
    runFrame();
    frameDebt -= NES_FRAME_MS;
  }

  loopId = requestAnimationFrame(update);
}
```

### Recommended refinement: reserve one frame for the visible render
The loop above should not consume *all* debt if a rendered frame is still intended in the same callback. A slightly better version is:

```js
while(frameDebt >= NES_FRAME_MS * 2 && skippedThisCallback < MAX_SKIP_FRAMES) {
  runFrameLogic();
  frameDebt -= NES_FRAME_MS;
  skippedThisCallback++;
}

if(frameDebt >= NES_FRAME_MS) {
  runFrame();
  frameDebt -= NES_FRAME_MS;
}
```

Why this is preferable:
- it keeps one owed frame available for the visible render
- it avoids a callback that only does invisible catch-up work and never presents the latest frame
- the screen shows the newest completed frame after catch-up, which is what players want

## 4) Reset timing state when the loop is restarted
Any path that resumes animation should also reset:

```js
lastFrameTime = 0;
frameDebt = 0;
```

That includes:
- unpause path in `el("pause").onclick`
- ROM start path in `loadRom()` before the first `requestAnimationFrame(update)`
- tab visibility resume path if it restarts playback through the pause button flow

This prevents a long paused interval from being treated as emulation debt.

## 5) Preserve the manual `Run Frame` button behavior
`el("runframe").onclick` currently calls `runFrame()` directly. That can remain unchanged.

Important note for the design doc implementation:
- manual stepping should **not** accumulate or consume `frameDebt`
- it is a user-driven debug/control action, not part of the real-time scheduler

---

## Alternative Simpler Approach

A simpler version is to compute how many frames are owed from elapsed time and only render the last one:

```js
let framesOwed = Math.floor(frameDebt / NES_FRAME_MS);
framesOwed = Math.min(framesOwed, MAX_SKIP_FRAMES + 1);

for(let i = 0; i < framesOwed; i++) {
  let isLast = i === framesOwed - 1;
  if(isLast) runFrame();
  else runFrameLogic();
  frameDebt -= NES_FRAME_MS;
}
```

Pros:
- shorter code
- easy to understand

Cons:
- slightly less explicit about “skip until one frame remains for render”
- less flexible if the 60 fps cap logic already has its own gating rules

Either implementation is acceptable. The debt-based while-loop is the better long-term fit.

---

## Edge Cases

## 1) First Frame
On the first RAF callback, `lastFrameTime` has no valid previous timestamp.

Plan:
- if `lastFrameTime === 0`, set `lastFrameTime = timestamp`
- do not treat startup as elapsed debt
- begin accumulating from the next callback

Without this guard, the first callback could incorrectly think a large amount of time has elapsed.

## 2) Tab Hide / Tab Resume
Background tabs may stop or heavily throttle RAF. When the page becomes visible again, the next timestamp may jump far forward.

Plan:
- clamp `frameDebt` to `MAX_FRAME_DEBT_MS`
- also reset `lastFrameTime` and `frameDebt` when resuming from a deliberate paused/tab-hidden state

Preferred behavior on resume:
- do **not** burst through dozens of catch-up frames
- simply continue from the current moment with minimal debt

This aligns with the existing `document.onvisibilitychange` behavior, which already pauses when hidden and resumes when shown.

## 3) Manual Pause / Unpause
If the emulator is paused for 5 seconds, those 5 seconds should not become emulation work later.

Plan:
- on pause: stop RAF as today
- on unpause: clear `frameDebt` and reset `lastFrameTime`

## 4) Large One-Off Stall (GC, debugger breakpoint, laptop hiccup)
A single callback may arrive much later than expected.

Plan:
- cap `frameDebt`
- allow only up to `MAX_SKIP_FRAMES` invisible catch-up frames in that callback
- run at most one visible frame after catch-up

This prevents lock-up and keeps input/audio responsive.

## 5) No Debt / Small Debt
On a fast machine, `frameDebt` should usually remain below one frame.

Behavior:
- no skip loop runs
- one normal `runFrame()` should occur only when enough frame time is owed under the final update design

If the existing 60 fps cap logic is also present, it should determine whether enough time has accrued to run a frame at all.

---

## Audio Considerations

Skipped render frames must still produce audio.

### Why audio must stay in the logic path
`nes.runFrame()` advances the APU state for one full NES frame. If skipped frames did not also call:

```js
nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
audioHandler.nextBuffer();
```

then audio would immediately drift behind emulation state, or the output buffer would underrun/stutter even though game logic had advanced.

### Why this keeps audio in sync
During catch-up:
- each emulated frame still generates one frame’s worth of audio samples
- audio buffers stay aligned with game state progression
- only video presentation frequency is reduced

This is exactly what we want on a slow machine: audio/gameplay remain near real time, while visual smoothness degrades gracefully.

### Risk to call out
If the machine is *extremely* slow, even logic-only frames may still not be fast enough. In that case:
- the skip cap prevents an infinite catch-up spiral
- the emulator may still sound rough under extreme slowdown
- but it should remain substantially better than the current “everything slows down equally” behavior

---

## Interaction with the 60fps-Cap Feature

These features solve opposite problems and should coexist in the same scheduler.

### 60 fps cap solves fast-display overrun
On 120/144/240 Hz displays, plain RAF can fire more often than NES frame cadence. The 60 fps cap ensures the emulator does **not** run too many frames just because the display refreshes faster.

### Frame skip solves slow-machine underrun
When callbacks arrive late or take too long, frame skipping ensures the emulator does **not** slow game time just because rendering every frame is too expensive.

### Shared update-loop model
Both fit naturally into the same `frameDebt`-based `update(timestamp)`:
- fast display: callbacks come frequently, but `frameDebt` often stays below `NES_FRAME_MS`, so no frame runs yet
- normal display: `frameDebt` reaches about one frame per callback, so one visible frame runs
- slow machine: `frameDebt` grows above one frame, so extra logic-only frames are used to catch up before rendering

### Practical coexistence rule
Use `frameDebt` as the single source of truth:
- add elapsed real time every callback
- only emulate when enough debt exists for one NES frame
- if more than one frame is owed, consume extra debt with skip frames, capped

That means the same `update()` function can handle:
- high refresh rate displays
- normal 60 Hz displays
- temporary browser stalls
- modest CPU throttling

No separate timing system is required.

---

## Recommended Pseudocode

```js
const NES_FRAME_MS = 1000 / 60.0988;
const MAX_SKIP_FRAMES = 4;
const MAX_FRAME_DEBT_MS = NES_FRAME_MS * (MAX_SKIP_FRAMES + 1);

let lastFrameTime = 0;
let frameDebt = 0;

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

function resetFrameScheduler() {
  lastFrameTime = 0;
  frameDebt = 0;
}

function update(timestamp) {
  if(!lastFrameTime) {
    lastFrameTime = timestamp;
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

  loopId = requestAnimationFrame(update);
}
```

This is the implementation shape the code change should follow.

---

## Verification Steps

## A. Confirm the emulator drops frames instead of slowing game time
1. Open the emulator in Chrome.
2. Load a ROM with obvious timed motion or music.
3. Open DevTools → Performance or Rendering tools.
4. Enable CPU throttling at **4x** and then **6x**.
5. Observe behavior before and after the change.

Expected result:
- visual smoothness worsens somewhat
- gameplay speed stays much closer to real time than today
- the emulator appears to drop rendered frames rather than uniformly slow all motion

## B. Temporarily log skip counts
Add a temporary debug line inside `update()` after the skip loop, for example:

```js
if(skippedThisCallback > 0) {
  console.log("skipped frames:", skippedThisCallback, "frameDebt:", frameDebt);
}
```

Test under CPU throttle.

Expected result:
- logs stay mostly silent on a fast machine
- logs appear under 4x/6x throttle
- skip counts remain bounded by `MAX_SKIP_FRAMES`

Remove the log after verification.

## C. Confirm audio remains acceptable under mild slowdown
1. Use **2x CPU throttle**.
2. Load a ROM with steady music.
3. Play for 30-60 seconds.

Expected result:
- no obvious underrun at mild throttle
- audio remains aligned with game action
- the game does not sound as though it is running in slow motion

## D. Confirm the skip cap prevents death spirals
1. Use **8x CPU throttle** or another extreme slowdown.
2. Watch skip count logging.
3. Interact with the game briefly.

Expected result:
- skip count never exceeds `MAX_SKIP_FRAMES`
- the page does not enter an endless catch-up burst
- the emulator may still struggle, but it should remain responsive enough to recover when load decreases

## E. Confirm no skips on a normal fast machine
1. Run with no CPU throttling on a typical 60 Hz display.
2. Optionally log `frameDebt` occasionally.

Expected result:
- `frameDebt` stays near zero or below one frame most of the time
- `skippedThisCallback` is almost always `0`
- normal rendering behavior is unchanged

## F. Confirm pause/unpause still behaves correctly
1. Start a ROM.
2. Pause the emulator for several seconds.
3. Unpause.

Expected result:
- no burst of catch-up frames on resume
- gameplay resumes immediately from current state
- no giant skip count appears after unpause

## G. Confirm tab hide/show still behaves correctly
1. Start a ROM.
2. Switch tabs or minimize long enough for RAF to stop/throttle.
3. Return to the emulator tab.

Expected result:
- the existing background-pause behavior still works
- on resume, the emulator does not attempt to replay all missed wall-clock time
- no large visual/audio burst occurs

---

## Implementation Notes for the Developer

- Prefer the **split logic/render** refactor; it makes the final code easier to maintain.
- Move `pollGamepads()` out of `runFrame()` and into `update(timestamp)` so skipped frames do not repeatedly re-read inputs during one callback.
- Add a small helper such as `resetFrameScheduler()` and call it from every place that restarts the loop.
- Keep the manual “Run Frame” button independent from the real-time debt system.
- Clamp debt aggressively on resume/stall; correctness here is about user-perceived real-time behavior, not replaying every missed wall-clock millisecond.

---

## Expected Outcome

After this change:
- slow machines should **drop rendered frames before they slow emulated time**
- audio should remain better synchronized with gameplay
- tab resume and pause/unpause should not cause giant catch-up bursts
- fast machines should behave the same as before
- the existing or planned 60 fps cap should coexist cleanly with the same scheduler
