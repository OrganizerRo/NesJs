# Mapper 206 (Namcot 108) Support Plan for NesJs

Repository: `OrganizerRo/NesJs`  
Reference implementation: `binji/binjnes` (mapper 206 behavior and bank-select/bank-data semantics)

---

## Refined File-Level Implementation Targets

### 1) Mapper registry/loader
- `nes/mappers.js`
- Confirms global `mappers[]` registry pattern.
- Action: add new file `mappers/mapper206.js` with `mappers[206] = function(...) { ... }`.
- Also ensure build/load includes it wherever mapper files are imported/loaded (HTML script include in `index.html` and `debug.html`).

### 2) New mapper implementation
- New file: `mappers/mapper206.js`
- Use `mappers/mmc3.js` as structural template for:
  - PRG-RAM behavior ($6000-$7FFF) if cartridge has it (if repo style keeps prgRam regardless, follow repo conventions)
  - `getRomAdr`, `getChrAdr`, `getMirroringAdr`
  - `read/write`, `ppuRead/ppuWrite/ppuPeak`, `reset`, `saveVars`
- Strip/omit IRQ machinery from MMC3 path for mapper 206 unless proven needed for this repo's target ROM set.

Recommended state fields in Mapper206:
- `name = "Mapper 206"` (or Namcot 108)
- `version = 1`
- memory buffers:
  - `chrRam` (for CHR-RAM carts), `prgRam`, `ppuRam`
- control registers:
  - `regSelect`, `prgMode`, `chrMode`, `bankRegs = new Uint8Array(8)` (or JS array)
- `mirroring` (runtime H/V state)
- optional derived/precomputed bank slot arrays for performance:
  - `prgSlots[4]` in 8KB units
  - `chrSlots[8]` in 1KB units

Address decode in `write(adr, value)` (MMC3-style):
- `switch (adr & 0x6001):`
  - `0x0000`: bank select/mode bits
  - `0x0001`: bank data for selected register
  - `0x2000`: mirroring control
  - `0x2001`: ignore/protect stub (no-op comment, consistent with repo style)
  - Ignore IRQ cases (`0x4000/0x4001/0x6000/0x6001`) for mapper 206 unless needed.

### 3) Save-state hooks
- Pattern in existing mappers: `this.saveVars = [...]`
- In `mappers/mapper206.js` include:
  - `"name", "chrRam", "prgRam", "ppuRam", "regSelect", "prgMode", "chrMode", "bankRegs", "mirroring"`
  - plus any derived slot arrays only if needed; otherwise recompute on load/reset to avoid redundancy.
- No global save-state update should be needed if core iterates `mapper.saveVars` dynamically.

### 4) Existing mapper references
- `mappers/mmc3.js` for behavior and integration template.
- `mappers/nrom.js`, `mappers/uxrom.js`, `mappers/mmc1.js`, `mappers/cnrom.js`, `mappers/axrom.js` for style patterns.

### 5) Documentation touch
- Optional: add a short line in README mapper support section if present.

---

## Minimal Mapper 206 Pre-Merge Test Matrix

### A. Register semantics (no ROM dependency; harness-level)
Use a tiny synthetic cart config with known PRG/CHR sizes.

- Bank select write
  - Write: `$8000 = 0x00` → expect `regSelect=0`, `prgMode=0`, `chrMode=0`
  - Write: `$8000 = 0xC7` → expect `regSelect=7`, `prgMode=1`, `chrMode=1`
- Bank data write applies selected register
  - Pre: `regSelect=3`, write `$8001=0x2A`
  - Expect: `bankRegs[3] == 0x2A` (or masked equivalent)
- Mirroring control
  - Write `$A000=0` then `$A000=1`
  - Expect `getMirroringAdr(0x2000..)` matches repo vertical/horizontal mapping conventions.

### B. PRG bank transition checks (8KB slot behavior)
- PRG mode 0 mapping
  - Set `prgMode=0`, program bank regs for PRG slots
  - Read sample addresses: `$8000`, `$A000`, `$C000`, `$E000`
  - Expect mode-0 layout.
- PRG mode 1 mapping
  - Toggle mode via `$8000` bit 6
  - Re-read same addresses
  - Expect fixed/switchable regions swapped per mode-1 semantics.

### C. CHR bank transition checks (1KB/2KB logic)
- CHR mode 0
  - Program CHR bank regs, peek PPU at:
    `$0000`, `$0400`, `$0800`, `$0C00`, `$1000`, `$1400`, `$1800`, `$1C00`
  - Expect `2KB+2KB+1KB*4` organization.
- CHR mode 1
  - Toggle mode bit 7 via `$8000`
  - Re-check same addresses
  - Expect upper/lower arrangement swapped per mode semantics.

### D. Bounds/mask safety
- Out-of-range bank writes
  - Write large values (`0xFF`) into PRG/CHR regs
  - Expect addresses masked by `h.prgAnd` / `h.chrAnd`, no OOB exceptions.

### E. State persistence
- Save/load mapper state
  - Set non-default regs/modes/mirroring
  - `state = nes.getState(); nes.reset(true); nes.setState(state);`
  - Expect sampled CPU/PPU mapping results unchanged.

### F. ROM smoke (manual)
- Boot at least one mapper-206 ROM
- Verify:
  - reaches title screen
  - stable after scene transitions that trigger bank switching
  - no immediate CHR corruption/freeze

---

## Performance/Cycle-Risk Callouts
- Recomputing full slot maps on every `$8001` is acceptable initially for correctness.
- Avoid new-array allocations inside `write()`; mutate fixed arrays.
- Do not add IRQ/A12 logic from MMC3 unless required.

---

---

## 1) Goal and Scope

Add accurate support for **iNES Mapper 206** (Namcot 108 family behavior as used by common 206 ROMs), with a staged rollout:

1. **Accuracy-first** implementation (correct PRG/CHR banking, mirroring control, write semantics)
2. **Verification-first** test execution and ROM validation
3. **Performance tuning** only after correctness is established

Out of scope (unless repo architecture already supports these in mapper 206 path):
- IRQ features from MMC3-like variants not used by mapper 206
- Non-iNES metadata formats unless currently supported in NesJs core loading path

---

## 2) Mapper 206 Functional Model (Behavior Contract)

Use `binjnes` mapper 206 handling as behavioral ground truth.

Mapper 206 is operationally similar to an MMC3-style register pair model for banking writes:

- **$8000 (bank select / mode bits)**
  - Selects target bank register
  - Carries PRG/CHR mode bits that affect mapping arrangement
- **$8001 (bank data)**
  - Writes value into selected bank register
  - Triggers recomputation of PRG/CHR mapping
- **$A000 (mirroring control)**
  - Horizontal/vertical mirroring control (respect cartridge hard-wired constraints where applicable)

Expected resources:
- 8KB PRG banking granularity in CPU space (typically fixed + switchable segments in MMC3-like arrangement)
- 1KB/2KB CHR bank granularity in PPU space depending on register class and mode

> Important: Keep exact mask behavior tied to available PRG/CHR bank count and ROM size to avoid out-of-range indexing.

---

## 3) Codebase Integration Strategy (NesJs)

### 3.1 Identify insertion points

Locate mapper infrastructure:
- mapper factory/dispatch by iNES mapper ID
- base mapper class hooks for CPU/PPU address decode
- PRG/CHR bank map helpers and mirroring API

Likely files (confirm in repo):
- mapper registry file (e.g., `mappers.js`, `mapperFactory.js`, etc.)
- existing MMC3-family mapper implementation (best template)
- cartridge/header parser where mapper number is read

### 3.2 Implementation style

Prefer:
- small dedicated `Mapper206` class/module
- reuse shared bank mapping utilities
- avoid copy/paste from MMC3 with unsupported IRQ scaffolding unless necessary

Rationale:
- isolates behavior differences
- easier test surface
- lower regression risk

---

## 4) Implementation Phases

## Phase A — Skeleton + Wiring

1. Add mapper ID 206 dispatch in mapper factory.
2. Create `Mapper206` with:
   - reset/init state
   - register storage (`bankSelect`, bank register array, mode bits)
   - CPU write handler for $8000/$8001/$A000 decode
3. Connect mirroring API updates.

Deliverable:
- ROMs with mapper 206 no longer fail at "unsupported mapper" stage.

## Phase B — Banking Semantics (Accuracy First)

Implement register semantics based on `binjnes` behavior:

1. **Bank select decode**
   - selected register index
   - PRG mode bit
   - CHR mode bit
2. **Bank data write**
   - store into selected register
   - apply masks:
     - PRG bank mask by available 8KB pages
     - CHR bank mask by available 1KB pages
3. **PRG map recompute**
   - MMC3-like slot ordering with one/two fixed regions and switchable regions depending on PRG mode
4. **CHR map recompute**
   - mode-dependent arrangement of 2KB/1KB logical regions
5. **Mirroring write**
   - map write bit to H/V per existing emulator conventions

Deliverable:
- deterministic PRG/CHR behavior for known mapper 206 titles.

## Phase C — Hardening and Edge Cases

1. Power-on defaults matching reference behavior.
2. Bounds-safe bank clipping/wrapping policy.
3. Open-bus or ignored-write behavior for unmapped write ranges per project conventions.
4. Save-state compatibility:
   - serialize all mapper 206 registers and mode bits

Deliverable:
- mapper survives reset/load-state and edge ROM layouts.

---

## 5) Verification Phases

## Phase V1 — Static and Unit-Level Validation

Add mapper-focused tests (if test harness exists):

- Write sequence tests:
  - write $8000 select, write $8001 data, assert resulting PRG/CHR slot map
- Mode toggle tests:
  - PRG mode flip changes slot arrangement correctly
  - CHR mode flip swaps region arrangement correctly
- Mirroring tests:
  - $A000 writes drive H/V state correctly
- Masking tests:
  - short PRG/CHR ROM sizes never index out-of-range

If no unit test framework exists:
- add a minimal deterministic mapper test harness for map tables only (no full frame emulation)

## Phase V2 — ROM-Based Functional Validation

Run known mapper 206 ROMs (homebrew/test + game ROMs user-legally-owned) and verify:

- boots to title
- stable gameplay for 3–5 minutes
- no obvious CHR corruption during scrolling/scene changes
- no hard lock on bank transition events

Collect diagnostics:
- log all writes to $8000/$8001/$A000 for first N frames (toggle via debug flag)
- compare trace patterns against expected reference behavior from `binjnes` run when possible

## Phase V3 — Regression Sweep

Re-run a subset of existing mapper regression titles:
- NROM/UxROM/CNROM/MMC1/MMC3 paths unchanged
- Ensure factory dispatch change for mapper 206 did not alter unknown-mapper behavior

---

## 6) Performance and CPU-Cycle Concerns

Mapper 206 itself is usually not the top CPU hotspot, but incorrect implementation can add overhead.

### Potential concerns

1. **Recomputing full PRG/CHR map on every write**
   - Usually acceptable, but frequent writes can accumulate.
2. **Branch-heavy decode in hot CPU write path**
   - Excess conditionals per write can degrade JS JIT optimization.
3. **Excess allocations in map recompute**
   - creating new arrays/objects each bank write can trigger GC pressure.

### Recommended workarounds/hints

- Keep bank maps in preallocated arrays; mutate in place.
- Use integer masks and bitwise ops to stay JIT-friendly.
- Recompute only the affected map side when possible:
  - e.g., mirroring write should not recompute PRG/CHR.
- Optional micro-opt: dirty flags
  - `prgDirty`, `chrDirty`; flush before fetch boundaries or immediately after write without realloc.
- Keep debug tracing behind compile/runtime flag to avoid runtime overhead in normal play.

### Accuracy vs performance rule

If a performance optimization risks altering mapping order/timing observability, keep the accurate variant by default and gate optimization behind a clearly documented fast path.

---

## 7) Decision Points Requiring Clarification

## Decision 1 — Mirroring override policy

Question: Should mapper 206 `$A000` writes always control mirroring, or should cartridge-level fixed mirroring override writes when header indicates fixed behavior?

- **Option A: Always honor `$A000` writes**
  - Pros: aligns with many mapper implementations and expected game behavior
  - Cons: may conflict with edge carts/headers with fixed mirroring assumptions
- **Option B: Respect cartridge fixed mirroring flag and ignore runtime writes when fixed**
  - Pros: safer for strict header-driven emulation policy
  - Cons: may break titles expecting dynamic mirroring control

Recommended default: **Option A**, unless NesJs has a strict global policy for fixed mirroring.

## Decision 2 — Bank overflow behavior

Question: On out-of-range bank value after masking, should behavior wrap (`& mask`) or clamp?

- **Option A: Wrap/mask**
  - Pros: closer to hardware/address-line behavior; common in emulators
  - Cons: can hide malformed test ROM issues
- **Option B: Clamp**
  - Pros: easier debugging for invalid bank writes
  - Cons: less hardware-faithful

Recommended default: **Option A (wrap/mask)** for accuracy.

## Decision 3 — Save-state compatibility strategy

Question: If existing save-state format is versioned, should mapper 206 state be appended with backward-compatible defaults?

- **Option A: Version bump with explicit mapper state block**
  - Pros: explicit and robust
  - Cons: requires migration handling
- **Option B: Opportunistic optional fields**
  - Pros: minimal disruption
  - Cons: risk of silent mismatch on older states

Recommended default: **Option A** if the project already versions state.

---

## 8) Suggested Work Breakdown (PR Checklist)

- [ ] Add mapper 206 ID route in factory
- [ ] Add `Mapper206` class/module
- [ ] Implement $8000/$8001/$A000 write decode
- [ ] Implement PRG recompute logic
- [ ] Implement CHR recompute logic
- [ ] Add mirroring control handling
- [ ] Add/reset power-on defaults
- [ ] Add save-state serialize/deserialize fields
- [ ] Add mapper 206 unit tests / harness tests
- [ ] Run ROM validation checklist and record results
- [ ] Run non-206 regression subset
- [ ] Remove/disable verbose debug traces for production

---

## 9) Acceptance Criteria

Support is complete when:

1. Mapper 206 ROMs load and run without unsupported-mapper error.
2. PRG/CHR bank switching behavior matches reference expectations from `binjnes` traces.
3. Mirroring behavior is correct per selected policy and documented.
4. No regressions in existing mapper smoke tests.
5. No measurable frame-time regression in baseline non-206 workloads.

---

## 10) Notes for Implementer

- Mirror exact register semantics from `binjnes` for mapper 206 first; only then adapt to NesJs abstractions.
- Keep a temporary write-trace logger to compare bank transitions while validating.
- Do not optimize away recompute steps until behavior is verified with at least one known-good ROM trace.
