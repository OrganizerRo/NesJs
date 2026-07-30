# Max-60 FPS Render Throttle Plan for Fast Displays

Repository: `NesJs`  
Primary file: `js/main.js`

---

## 1) Goal and Scope

### Goal
Prevent the emulator from running faster than intended on high-refresh-rate displays by ensuring the main loop executes **at most one NES frame per NTSC frame period**.

Today, `requestAnimationFrame` drives `update()` at the display refresh rate. On 120 Hz and 144 Hz monitors, that causes `runFrame()` to execute more often than the NES should advance, which speeds up gameplay, animation, and audio.

The target behavior is:
- **Cap emulation + render to ~60.0988 fps** regardless of monitor refresh rate
- Run frames at approximately **16.639 ms** intervals
- Keep the `requestAnimationFrame` loop alive on every callback, even when a frame is skipped
- Avoid changing the emulator core timing model outside the browser loop

### In Scope
- Updating the browser loop in `js/main.js`
- Passing the RAF timestamp into `update(timestamp)`
- Tracking elapsed wall-clock time between rendered/emulated frames
- Skipping a frame when insufficient time has elapsed
- Handling first-frame, pause/resume, and tab visibility edge cases
- Documenting expected audio behavior when frames are skipped

### Out of Scope
- Reworking emulator internals (`nes.runFrame()` timing, CPU, PPU, or APU logic)
- Implementing catch-up logic that runs multiple frames after a long stall
- Adding interpolation, frame blending, or decoupled render/emulation pipelines
- Supporting PAL timing changes in this patch
- Solving latency or drift issues unrelated to high-refresh displays

---

## 2) Current Problem

Current loop:

```js
function update() {
  runFrame();
  loopId = requestAnimationFrame(update);
}
```

Because `requestAnimationFrame` fires once per display refresh:
- 60 Hz display -> ~60 callbacks/sec -> behavior is roughly correct
- 120 Hz display -> ~120 callbacks/sec -> emulator runs at ~2x speed
- 144 Hz display -> ~144 callbacks/sec -> emulator runs at ~2.4x speed

The fix is to treat RAF as a **tick source**, not as permission to always run a full NES frame.

---

## 3) Proposed Approach

Use the `DOMHighResTimeStamp` provided by `requestAnimationFrame` to decide whether enough real time has elapsed to run another NES frame.

### Timing Constant
Add a constant in `js/main.js`:

```js
const NES_FRAME_MS = 1000 / 60.0988;
```

This is approximately:

```js
16.639 ms
```

### State to Track
Add a module-level variable:

```js
let lastFrameTime = 0;
```

This stores the timestamp of the **last frame that actually ran**, not the last RAF callback.

### Updated Loop Behavior
Change the callback signature to:

```js
function update(timestamp)
```

On each RAF callback:
1. Immediately schedule the next RAF callback
2. If this is the first frame, allow the frame to run
3. Compute `elapsed = timestamp - lastFrameTime`
4. If `elapsed < NES_FRAME_MS`, return early and do **not** call `runFrame()`
5. Otherwise, update `lastFrameTime = timestamp` and run the frame

This makes 120 Hz / 144 Hz displays naturally drop excess RAF callbacks while keeping emulation cadence near the intended NTSC rate.

---

## 4) Exact Code Changes Needed in `js/main.js`

### A. Add the frame-period constant
Near the top-level state declarations, add:

```js
const NES_FRAME_MS = 1000 / 60.0988;
```

Recommended placement: near other loop/runtime state such as `paused`, `loaded`, `pausedInBg`, and `loopId`.

### B. Add `lastFrameTime`
Add a new top-level variable:

```js
let lastFrameTime = 0;
```

Use `0` as the sentinel meaning “no rendered frame has run yet”.

### C. Change the `update` signature
Replace:

```js
function update() {
```

with:

```js
function update(timestamp) {
```

This uses the `DOMHighResTimeStamp` supplied by RAF.

### D. Schedule the next RAF callback before any early return
This is critical. The function should continue to re-arm RAF even when the current callback is skipped.

Conceptually, the top of `update` should become:

```js
function update(timestamp) {
  loopId = requestAnimationFrame(update);
  ...
}
```

This ordering matters because if the time-check returns early before scheduling the next callback, the loop would stop on the first skipped frame.

### E. Add the time-check guard
After scheduling the next RAF callback, add elapsed-time gating:

```js
if(lastFrameTime !== 0 && (timestamp - lastFrameTime) < NES_FRAME_MS) {
  return;
}
```

This ensures:
- the first frame is not skipped
- subsequent frames only run after enough time has elapsed

### F. Update `lastFrameTime` only when a frame actually runs
Before or immediately after `runFrame()`, set:

```js
lastFrameTime = timestamp;
```

Do **not** update `lastFrameTime` on skipped callbacks. If it were updated during skipped frames, the clock would keep resetting and a real frame might never become eligible on fast displays.

### G. Resulting control flow
The intended structure is:

```js
function update(timestamp) {
  loopId = requestAnimationFrame(update);

  if(lastFrameTime !== 0 && (timestamp - lastFrameTime) < NES_FRAME_MS) {
    return;
  }

  lastFrameTime = timestamp;
  runFrame();
}
```

This is the core design shape. Minor formatting differences are fine, but the behavior must stay the same.

---

## 5) Edge Cases and Handling

### First frame (`lastFrameTime === 0`)
Problem:
- On the very first RAF callback after startup, ROM load, or resume, there is no prior rendered-frame timestamp.

Handling:
- Treat `lastFrameTime === 0` as a special case and allow `runFrame()` immediately.
- After the frame runs, set `lastFrameTime = timestamp`.

Why:
- This avoids an unnecessary startup delay and gives a clean initial baseline.

### Tab hidden / tab shown again (large delta spike)
Problem:
- When a tab is hidden, RAF is paused or heavily throttled by the browser.
- When the tab becomes visible again, the next timestamp may be much larger than the previous one.

Handling:
- A large elapsed delta should **not** trigger catch-up logic.
- The loop should simply run one frame, set `lastFrameTime = timestamp`, and continue normally.

Why:
- The requested fix is a max-60-fps throttle, not a catch-up scheduler.
- Running many deferred frames at once would create a visible and audible burst and would change behavior beyond scope.

Optional robustness note:
- Resetting `lastFrameTime` to `0` on pause/hide or just before restarting the loop is acceptable if the implementation wants a clean resume baseline.
- Even without that reset, the next visible callback still runs at most one frame, so either approach is compatible with the design.

### Paused state
Problem:
- The app already pauses by cancelling RAF and stopping audio.
- If `lastFrameTime` is left unchanged forever, resume behavior should still be deliberate.

Handling:
- On unpause, the first new RAF callback should be allowed to run promptly.
- The simplest design is to reset `lastFrameTime = 0` when entering or leaving paused mode, or immediately before scheduling a resumed RAF loop.

Why:
- This avoids odd timing carry-over from the pre-pause timestamp.
- It makes pause/unpause behavior deterministic and easier to reason about.

### Short-term RAF jitter
Problem:
- Browser callbacks are not perfectly uniform; some intervals may be slightly shorter or longer than 16.639 ms.

Handling:
- Use a strict `< NES_FRAME_MS` skip check.
- Accept normal timing jitter rather than trying to compensate with accumulation math in this change.

Why:
- The design goal is simple throttling with minimal code churn.
- More advanced drift compensation can be evaluated later if needed.

---

## 6) Interaction with Audio

`runFrame()` currently performs both emulation and audio production:

```js
pollGamepads();
nes.runFrame();
nes.getSamples(audioHandler.sampleBuffer, audioHandler.samplesPerFrame);
audioHandler.nextBuffer();
nes.getPixels(imgData.data);
ctx.putImageData(imgData, 0, 0);
```

With the throttle in place:
- **Skipped RAF callbacks produce no audio samples**
- Audio is only generated when a real NES frame is run

This is acceptable for this fix because:
1. The current bug is that high-refresh displays are generating **too many** emulation/audio frames
2. After throttling, 60 Hz displays should continue producing one audio chunk per intended NES frame
3. On 120 Hz/144 Hz displays, skipped callbacks are merely removing the extra audio generation that caused fast playback
4. The existing audio buffering path is already the right place to absorb normal browser scheduling jitter and brief underrun risk

Documented expectation:
- On a correctly functioning 60 Hz path, audio should remain continuous.
- On high-refresh displays, audio speed should become correct because sample production now matches intended frame cadence.
- This change does **not** attempt to redesign audio timing independently of the frame loop.

---

## 7) Recommended Implementation Notes

### Keep the change localized
All behavior should be implemented in `js/main.js`, centered on the RAF loop. Avoid touching emulator-core files unless a follow-up bug demands it.

### Preserve manual single-frame stepping
`runFrame()` is also used by the `runframe` button. The throttle should only affect the RAF-driven `update(timestamp)` loop, not direct manual calls to `runFrame()`.

### Preserve existing pause and visibility semantics
The current `pause` button and `document.onvisibilitychange` logic should keep their existing responsibilities:
- pausing/unpausing the loop
- starting/stopping audio
- releasing gamepad inputs when hidden

Only timing-gating logic should be added around the RAF loop.

---

## 8) Verification Steps

### A. Verify frame spacing in DevTools on a 120 Hz display
1. Open the emulator in a browser on a machine with a 120 Hz display.
2. Load a ROM and start gameplay.
3. Open **DevTools -> Performance**.
4. Record several seconds of activity.
5. Inspect the cadence of the RAF-driven work or add temporary markers around `runFrame()`.

Expected result:
- Effective emulated/rendered frames occur about every **16.6 ms**
- They should **not** occur every **8.3 ms**

Interpretation:
- RAF callbacks may still arrive every ~8.3 ms on a 120 Hz panel, but every other callback should typically be skipped.

### B. Verify skip rate with temporary timestamp logging
Add temporary logging during development, for example logging:
- RAF callback timestamp
- whether the frame ran or was skipped
- current `timestamp - lastFrameTime`

On a 120 Hz display, expected result:
- Roughly **50% of RAF callbacks** are skipped
- The exact number may vary slightly due to browser jitter and monitor timing

A useful sanity check is that “run” events cluster near ~16.6 ms apart even though callbacks arrive near ~8.3 ms apart.

### C. Verify game speed against wall-clock time
1. Load a ROM with a visible timer or easy-to-measure repeated event.
2. Compare in-game elapsed time to a real stopwatch for at least 30-60 seconds.

Expected result:
- In-game time should closely track wall-clock time.
- On a 120 Hz or 144 Hz display, the prior “game runs too fast” symptom should be gone.

### D. Verify audio continuity on a 60 Hz display
1. Run the emulator on a standard 60 Hz display.
2. Use a ROM with constant music or repeating sound effects.
3. Play for several minutes.

Expected result:
- Audio remains continuous
- No new stutter, gaps, or obvious crackling are introduced by the throttle logic

This is especially important because 60 Hz should behave almost exactly as before, except with the new explicit timing gate.

### E. Verify pause/unpause still works
1. Start a ROM.
2. Pause the emulator.
3. Wait a few seconds.
4. Unpause.

Expected result:
- The game stops while paused
- The game resumes correctly after unpause
- No runaway fast-forwarding or long stall occurs immediately after resume
- Audio pause/resume behavior remains correct

### F. Verify tab hide/show behavior
1. Start a ROM in a visible tab.
2. Switch to another tab or minimize the browser.
3. Wait several seconds.
4. Return to the emulator tab.

Expected result:
- The app still pauses/resumes according to current visibility logic
- No burst of catch-up frames occurs on return
- Inputs are not stuck
- Timing returns to the intended ~60 fps cadence once visible again

---

## 9) Acceptance Criteria

The change is successful when all of the following are true:
- On 120 Hz and 144 Hz displays, gameplay no longer runs faster than normal
- Effective emulation/render cadence is capped near **60.0988 fps**
- RAF continues ticking even when individual callbacks are skipped
- `runFrame()` is only invoked when at least one NES frame period has elapsed
- Pause/unpause and tab visibility behavior still work correctly
- Audio remains correct on 60 Hz displays and no longer speeds up on fast displays

---

## 10) Summary

The minimal, low-risk fix is to convert the RAF loop from “run every callback” to “run only when enough wall-clock time has elapsed.”

The key implementation points are:
- add `NES_FRAME_MS = 1000 / 60.0988`
- add `lastFrameTime`
- change `update()` to `update(timestamp)`
- call `requestAnimationFrame(update)` **before** any early return
- skip when `timestamp - lastFrameTime < NES_FRAME_MS`
- update `lastFrameTime` only when a frame actually runs

This keeps the current architecture intact while fixing the core high-refresh-rate speed bug.
