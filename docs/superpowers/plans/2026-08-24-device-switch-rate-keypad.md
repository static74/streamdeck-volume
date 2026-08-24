# Device Switching, Sample Rate, Keypad Variant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add press-and-turn output device switching, sample-rate display with long-touch cycling, and a Keypad variant of the volume action.

**Architecture:** All three features extend the existing pieces: pure logic goes into `bin/model.js` (unit-tested), system calls into the Swift helper `helper/audioctl.swift` (new stdin commands + JSON events), and wiring into `bin/plugin.js`. The dial's stock `$B1` layout is replaced by a custom layout JSON so a rate label fits.

**Tech Stack:** Plain-JS ESM Node plugin on `@elgato/streamdeck` v2 (no bundler, no new npm deps), single-file Swift helper compiled with `swiftc`, `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-08-24-streamdeck-volume-design.md` (section "v1.1 features")

## Global Constraints

- macOS 12+, Stream Deck app 6.5+, manifest `SDKVersion: 2`.
- Plain JavaScript ESM; tabs for indentation (match existing files); no new npm dependencies; no bundler.
- Helper stays one Swift file compiled by `make helper` (`swiftc -O helper/audioctl.swift -o com.sb.output-volume.sdPlugin/bin/audioctl`).
- Tests run with `node --test test/model.test.js` from the repo root (`make test`).
- Device UIDs contain spaces — any command carrying a UID parses it as rest-of-line, never `split(" ")`.
- The plugin's volume model updates ONLY from helper events (single source of truth); dial/key handlers just send commands. Preserve this.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Reload cycle for manual checks: `make install && make restart` (kills and reopens the Stream Deck app; the plugin dir is symlinked, so JS edits need only a restart, helper edits need `make helper` first).

## File Structure

- `com.sb.output-volume.sdPlugin/bin/model.js` — add `cycle`, `formatRate`, `pressTracker` (pure, tested).
- `helper/audioctl.swift` — add output-device enumeration, default-output setter, sample-rate get/set/listen; new commands `list`, `setdefault`, `setrate`; device event gains `rate`/`rates`.
- `com.sb.output-volume.sdPlugin/bin/plugin.js` — wire press-and-turn, rate display/cycling, keypad rendering.
- `com.sb.output-volume.sdPlugin/layouts/dial.json` — custom encoder layout (new).
- `com.sb.output-volume.sdPlugin/manifest.json` — Keypad controller, custom layout path, trigger descriptions.
- `tools/harness.mjs` — dev harness: run the plugin against a stub Stream Deck (new).
- `test/model.test.js` — new unit tests.
- `README.md` — document the three features (folded into the final task).

---

### Task 1: Pure model helpers — `cycle` and `formatRate`

**Files:**
- Modify: `com.sb.output-volume.sdPlugin/bin/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Produces: `cycle(length: number, index: number, delta: number) -> number` (wrapping index; `-1` when length is 0) and `formatRate(hz: number) -> string` (`44100 -> "44.1k"`, `96000 -> "96k"`). Tasks 5–7 import both from `./model.js`.

- [ ] **Step 1: Write the failing tests** — append to `test/model.test.js`:

```js
test("cycle wraps in both directions", async () => {
	const { cycle } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	assert.equal(cycle(3, 0, 1), 1);
	assert.equal(cycle(3, 2, 1), 0);
	assert.equal(cycle(3, 0, -1), 2);
	assert.equal(cycle(3, 1, -4), 0);
	assert.equal(cycle(0, 0, 1), -1);
});

test("formatRate renders kHz labels", async () => {
	const { formatRate } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	assert.equal(formatRate(44100), "44.1k");
	assert.equal(formatRate(48000), "48k");
	assert.equal(formatRate(96000), "96k");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: 2 failures — `cycle`/`formatRate` are not exported.

- [ ] **Step 3: Implement** — append to `bin/model.js`:

```js
// Wrapping index cycling, shared by device switching and rate cycling.
export function cycle(length, index, delta) {
	if (length === 0) return -1;
	return (((index + delta) % length) + length) % length;
}

export function formatRate(hz) {
	const k = hz / 1000;
	return (Number.isInteger(k) ? k : k.toFixed(1)) + "k";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add com.sb.output-volume.sdPlugin/bin/model.js test/model.test.js
git commit -m "Add cycle and formatRate model helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Press-and-turn state machine — `pressTracker`

**Files:**
- Modify: `com.sb.output-volume.sdPlugin/bin/model.js`
- Test: `test/model.test.js`

**Interfaces:**
- Consumes: `cycle` from Task 1.
- Produces: `pressTracker() -> { down(startIndex), rotate(ticks, length) -> {type:"preview", index}|null, up() -> {type:"mute"}|{type:"switch", index}|{type:"none"}, pressed: boolean }`. Task 6 drives it from dial events.

- [ ] **Step 1: Write the failing tests** — append to `test/model.test.js`:

```js
test("pressTracker: plain press resolves to mute", async () => {
	const { pressTracker } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	const t = pressTracker();
	t.down(2);
	assert.deepEqual(t.up(), { type: "mute" });
	assert.deepEqual(t.up(), { type: "none" });
});

test("pressTracker: press-and-turn previews then switches", async () => {
	const { pressTracker } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	const t = pressTracker();
	t.down(1);
	assert.deepEqual(t.rotate(2, 4), { type: "preview", index: 3 });
	assert.deepEqual(t.rotate(1, 4), { type: "preview", index: 0 });
	assert.deepEqual(t.up(), { type: "switch", index: 0 });
});

test("pressTracker: rotation without press or devices is inert", async () => {
	const { pressTracker } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	const t = pressTracker();
	assert.equal(t.rotate(1, 4), null);
	t.down(0);
	assert.equal(t.rotate(1, 0), null);
	assert.deepEqual(t.up(), { type: "mute" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/model.test.js`
Expected: failures — `pressTracker` not exported.

- [ ] **Step 3: Implement** — append to `bin/model.js`:

```js
// Press-and-turn state machine. down() starts a press; rotate() while
// pressed previews device candidates; up() resolves to a mute toggle
// (plain press) or a device switch (press-and-turn).
export function pressTracker() {
	let pressed = false;
	let rotated = false;
	let index = 0;
	return {
		down(startIndex) {
			pressed = true;
			rotated = false;
			index = startIndex;
		},
		rotate(ticks, length) {
			if (!pressed || length === 0) return null;
			rotated = true;
			index = cycle(length, index, ticks);
			return { type: "preview", index };
		},
		up() {
			if (!pressed) return { type: "none" };
			pressed = false;
			return rotated ? { type: "switch", index } : { type: "mute" };
		},
		get pressed() {
			return pressed;
		},
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/model.test.js`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add com.sb.output-volume.sdPlugin/bin/model.js test/model.test.js
git commit -m "Add pressTracker state machine for press-and-turn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Helper — device enumeration and default-output switching

**Files:**
- Modify: `helper/audioctl.swift`

**Interfaces:**
- Consumes: existing `addr(_:scope:)`, `deviceString(_:_:)`, `emit(_:)` helpers in the same file.
- Produces: stdin command `list` → event `{"e":"devices","devices":[{"name":String,"uid":String}]}`; stdin command `setdefault <uid>` (uid = rest of line) sets the macOS default output. Task 6 sends both commands and consumes the event.

- [ ] **Step 1: Implement enumeration + setter** — add above the `// MARK: - Main` section:

```swift
// MARK: - Output device switching

func outputDevices() -> [(id: AudioDeviceID, name: String, uid: String)] {
    var a = addr(kAudioHardwarePropertyDevices, scope: kAudioObjectPropertyScopeGlobal)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr,
          size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr
        else { return [] }
    return ids.filter { dev in
        // output-capable = has at least one output-scope stream
        var sa = addr(kAudioDevicePropertyStreams)
        var ssize = UInt32(0)
        AudioObjectGetPropertyDataSize(dev, &sa, 0, nil, &ssize)
        return ssize > 0
    }.map { ($0, deviceString($0, kAudioObjectPropertyName), deviceString($0, kAudioDevicePropertyDeviceUID)) }
}

func emitDeviceList() {
    let devs = outputDevices().map { ["name": $0.name, "uid": $0.uid] }
    emit(["e": "devices", "devices": devs])
}

func setDefaultOutput(uid: String) {
    guard let dev = outputDevices().first(where: { $0.uid == uid })?.id else { return }
    var a = addr(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
    var id = dev
    AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil,
                               UInt32(MemoryLayout<AudioDeviceID>.size), &id)
}
```

- [ ] **Step 2: Wire the commands** — in the stdin loop's `switch cmd`, add cases (note `setdefault` takes rest-of-line because UIDs contain spaces):

```swift
        case "list": emitDeviceList()
        case "setdefault":
            let uid = String(line.dropFirst("setdefault ".count))
            if !uid.isEmpty { setDefaultOutput(uid: uid) }
```

- [ ] **Step 3: Build and verify by hand**

```bash
make helper
(sleep 1; echo "list"; sleep 1) | com.sb.output-volume.sdPlugin/bin/audioctl | grep '"devices"' | python3 -m json.tool | head -20
```

Expected: a `devices` event listing the machine's output devices (names + uids), each with a non-empty uid. Do NOT test `setdefault` blind — verify it in Task 6's checkpoint where the effect is visible.

- [ ] **Step 4: Run existing tests still pass**

Run: `node --test test/model.test.js`
Expected: all pass (helper change must not affect them; this catches accidental repo breakage).

- [ ] **Step 5: Commit**

```bash
git add helper/audioctl.swift
git commit -m "Add device list and default-output commands to audioctl

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Helper — sample rate read, listen, and set

**Files:**
- Modify: `helper/audioctl.swift`

**Interfaces:**
- Consumes: existing `emitDevice`, `attachDeviceListeners`, `listenerQueue`, `currentDevice`.
- Produces: device event gains `"rate": Int` and `"rates": [Int]`; new event `{"e":"rate","hz":Int}` on nominal-rate changes; stdin command `setrate <hz>`. Task 7 consumes all three.

- [ ] **Step 1: Implement rate helpers** — add below the output-device functions:

```swift
// MARK: - Sample rate

func nominalRate(_ dev: AudioDeviceID) -> Int? {
    var a = addr(kAudioDevicePropertyNominalSampleRate, scope: kAudioObjectPropertyScopeGlobal)
    var r = Float64(0)
    var size = UInt32(MemoryLayout<Float64>.size)
    return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &r) == noErr ? Int(r) : nil
}

func availableRates(_ dev: AudioDeviceID) -> [Int] {
    var a = addr(kAudioDevicePropertyAvailableNominalSampleRates, scope: kAudioObjectPropertyScopeGlobal)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(dev, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ranges = [AudioValueRange](repeating: AudioValueRange(), count: Int(size) / MemoryLayout<AudioValueRange>.size)
    guard AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &ranges) == noErr else { return [] }
    return Array(Set(ranges.map { Int($0.mMinimum) })).sorted()
}

func setRate(_ dev: AudioDeviceID, _ hz: Int) {
    var a = addr(kAudioDevicePropertyNominalSampleRate, scope: kAudioObjectPropertyScopeGlobal)
    var r = Float64(hz)
    AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<Float64>.size), &r)
}
```

- [ ] **Step 2: Report rates in the device event** — in `emitDevice`, before `emit(obj)`:

```swift
    if let rate = nominalRate(dev) { obj["rate"] = rate }
    obj["rates"] = availableRates(dev)
```

- [ ] **Step 3: Add a rate-change listener** — in `attachDeviceListeners`, alongside the existing volume/mute listener blocks, add a third (declare `var rateListener: AudioObjectPropertyListenerBlock?` next to `volListener`/`muteListener`, remove it in the same place they are removed, using a `rateAddr` built like the others):

```swift
    var rateAddr = addr(kAudioDevicePropertyNominalSampleRate, scope: kAudioObjectPropertyScopeGlobal)
    // in the removal block at the top of attachDeviceListeners:
    //   if let rl = rateListener { AudioObjectRemovePropertyListenerBlock(currentDevice, &rateAddr, listenerQueue, rl) }
    // after the mute listener setup:
    let rateBlock: AudioObjectPropertyListenerBlock = { _, _ in
        if let hz = nominalRate(dev) { emit(["e": "rate", "hz": hz]) }
    }
    AudioObjectAddPropertyListenerBlock(dev, &rateAddr, listenerQueue, rateBlock)
    rateListener = rateBlock
```

- [ ] **Step 4: Wire the command** — in the stdin `switch cmd`:

```swift
        case "setrate":
            if parts.count > 1, let hz = Int(parts[1]) { setRate(currentDevice, hz) }
```

- [ ] **Step 5: Build and verify by hand**

```bash
make helper
(sleep 1; echo "") | com.sb.output-volume.sdPlugin/bin/audioctl | grep '"device"' | python3 -m json.tool
```

Expected: the device event now includes `"rate"` (e.g. 96000) and `"rates"` (e.g. [44100, 48000, 88200, 96000]).

- [ ] **Step 6: Commit**

```bash
git add helper/audioctl.swift
git commit -m "Report and control device sample rate in audioctl

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Dev harness + Keypad variant

**Files:**
- Create: `tools/harness.mjs`
- Modify: `com.sb.output-volume.sdPlugin/manifest.json`
- Modify: `com.sb.output-volume.sdPlugin/bin/plugin.js`

**Interfaces:**
- Consumes: the plugin's websocket registration protocol (`-port/-pluginUUID/-registerEvent/-info` argv contract, already implemented).
- Produces: `tools/harness.mjs` (used again in Tasks 6–7 for verification); keypad rendering via `setTitle`/`setImage`; `onKeyDown` toggles mute.

- [ ] **Step 1: Create the harness** — `tools/harness.mjs`:

```js
// Dev harness: runs the plugin against a stub Stream Deck websocket.
// Usage: node tools/harness.mjs
// Then type commands: down | up | rot <ticks> | prot <ticks> | key | tap | hold | quit
// Prints every message the plugin sends (setFeedback, setTitle, setImage, ...).
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "com.sb.output-volume.sdPlugin");
const { WebSocketServer } = createRequire(join(root, "package.json"))("ws");

const ACTION = "com.sb.output-volume.dial";
const DIAL = { context: "dial1", controller: "Encoder" };
const KEY = { context: "key1", controller: "Keypad" };
const coords = { column: 0, row: 0 };

const wss = new WebSocketServer({ port: 28999 });
wss.on("connection", (ws) => {
	const sendEv = (event, target, payload) =>
		ws.send(JSON.stringify({ event, action: ACTION, context: target.context, device: "dev1", payload }));
	ws.on("message", (m) => {
		const o = JSON.parse(m.toString());
		if (o.event === "registerPlugin") {
			sendEv("willAppear", DIAL, { settings: {}, coordinates: coords, controller: "Encoder", isInMultiAction: false });
			sendEv("willAppear", KEY, { settings: {}, coordinates: coords, controller: "Keypad", isInMultiAction: false });
			console.log("[harness] plugin registered; dial1 + key1 appeared. Commands: down|up|rot N|prot N|key|tap|hold|quit");
		} else {
			console.log("[plugin →]", JSON.stringify(o));
		}
	});
	createInterface({ input: process.stdin }).on("line", (line) => {
		const [cmd, arg] = line.trim().split(/\s+/);
		const ticks = Number(arg ?? 1);
		const base = { settings: {}, coordinates: coords, controller: "Encoder" };
		switch (cmd) {
			case "down": sendEv("dialDown", DIAL, base); break;
			case "up": sendEv("dialUp", DIAL, base); break;
			case "rot": sendEv("dialRotate", DIAL, { ...base, ticks, pressed: false }); break;
			case "prot": sendEv("dialRotate", DIAL, { ...base, ticks, pressed: true }); break;
			case "key": sendEv("keyDown", KEY, { settings: {}, coordinates: coords }); break;
			case "tap": sendEv("touchTap", DIAL, { ...base, tapPos: [100, 50], hold: false }); break;
			case "hold": sendEv("touchTap", DIAL, { ...base, tapPos: [100, 50], hold: true }); break;
			case "quit": process.exit(0);
		}
	});
});

const info = JSON.stringify({
	application: { font: "", language: "en", platform: "mac", platformVersion: "26.0", version: "7.4.2" },
	colors: {}, devicePixelRatio: 2,
	devices: [{ id: "dev1", name: "Stream Deck +", size: { columns: 4, rows: 2 }, type: 7 }],
	plugin: { uuid: "com.sb.output-volume", version: "1.0.0.0" },
});
const child = spawn(process.execPath,
	[join(root, "bin", "plugin.js"), "-port", "28999", "-pluginUUID", "harness", "-registerEvent", "registerPlugin", "-info", info],
	{ cwd: root, stdio: ["ignore", "inherit", "inherit"] });
process.on("exit", () => child.kill());
```

- [ ] **Step 2: Allow Keypad in the manifest** — in `manifest.json`, change the action's controllers:

```json
			"Controllers": ["Encoder", "Keypad"],
```

- [ ] **Step 3: Branch rendering and add the key handler** — in `bin/plugin.js`, replace the `render` function with:

```js
function render() {
	const payload = feedbackPayload();
	for (const a of dial.actions) {
		if (typeof a.setFeedback === "function") {
			a.setFeedback(payload);
		} else {
			a.setTitle(payload.value);
			a.setImage(state.muted ? "imgs/muted.svg" : "imgs/speaker.svg");
		}
	}
}
```

and add to the `VolumeDial` class:

```js
	onKeyDown() {
		this.#toggleMute();
	}
```

- [ ] **Step 4: Verify with the harness**

Run: `node tools/harness.mjs`, then type `key`, then `key`, then `quit`.
Expected: on startup, a `setTitle` (e.g. `"81%"`) and `setImage` (`imgs/speaker.svg`) for context `key1` alongside the dial's `setFeedback`; after the first `key`, real system mute toggles and `setTitle` shows `"Muted"` with `imgs/muted.svg`; after the second `key`, back to a percentage. (This drives the real system volume — it ends where it started.)

- [ ] **Step 5: Run tests, then commit**

Run: `node --test test/model.test.js` — all pass.

```bash
git add tools/harness.mjs com.sb.output-volume.sdPlugin/manifest.json com.sb.output-volume.sdPlugin/bin/plugin.js
git commit -m "Add Keypad variant and dev harness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Plugin — press-and-turn device switching

**Files:**
- Modify: `com.sb.output-volume.sdPlugin/bin/plugin.js`

**Interfaces:**
- Consumes: `pressTracker` (Task 2); helper `list`/`setdefault` and the `devices` event (Task 3); existing `send()`, `state`, `render()`, `dial.actions`.
- Produces: dial press semantics change — mute fires on dial-UP (plain press); press-and-turn previews and switches devices.

- [ ] **Step 1: Import and instantiate** — in `bin/plugin.js`, extend the model import and add module state near `state`:

```js
import { applyKey, pressTracker, seedVolume, stepVolume } from "./model.js";
```

```js
const press = pressTracker();
let deviceList = []; // [{ name, uid }] — refreshed at startup and on device change
```

- [ ] **Step 2: Track the device list** — in `handleEvent`, add a case, and request refreshes:

```js
		case "devices":
			deviceList = ev.devices;
			break;
```

In the `"hello"` case add `send("list");` and at the end of the `"device"` case add `send("list");` (keeps the list fresh across hotplug, since every default-output change re-emits the device event).

- [ ] **Step 3: Add the preview renderer** — next to `render()`:

```js
function renderPreview(device) {
	if (!device) return;
	const payload = { title: `→ ${device.name}`, value: "release to switch" };
	for (const a of dial.actions) {
		if (typeof a.setFeedback === "function") a.setFeedback(payload);
	}
}
```

- [ ] **Step 4: Rewire the dial handlers** — in the `VolumeDial` class, replace `onDialRotate` and `onDialDown`, and add `onDialUp`:

```js
	onDialRotate(ev) {
		const ticks = ev.payload.ticks;
		if (ticks === 0) return;
		if (ev.payload.pressed) {
			const r = press.rotate(ticks, deviceList.length);
			if (r) renderPreview(deviceList[r.index]);
			return;
		}
		if (state.mode === "native") {
			if (state.volume == null) return;
			send(`setvol ${stepVolume(state.volume, ticks)}`);
		} else {
			const key = ticks > 0 ? "up" : "down";
			for (let i = 0; i < Math.abs(ticks); i++) send(key);
		}
	}

	onDialDown() {
		const idx = deviceList.findIndex((d) => d.name === state.name);
		press.down(Math.max(0, idx));
	}

	onDialUp() {
		const r = press.up();
		if (r.type === "switch") {
			const d = deviceList[r.index];
			if (d && d.name !== state.name) send(`setdefault ${d.uid}`);
			render(); // clear the preview; the device event re-renders again after the switch
		} else if (r.type === "mute") {
			this.#toggleMute();
		}
	}
```

- [ ] **Step 5: Verify with the harness**

Run: `node tools/harness.mjs`, then: `down`, `prot 1`, `prot 1`, `up`, then `down`, `up`, then `quit`.
Expected: the two `prot` commands each produce a `setFeedback` whose title starts with `→ ` naming a real device from this machine's list; `up` after them triggers a real default-output switch (a fresh `device` event renders the new name — **the Mac's audio output actually changes**); the plain `down`/`up` pair toggles mute on the new device. Switch the default output back afterwards via the same steps (or System Settings → Sound).

- [ ] **Step 6: Deploy and hardware-check** *(checkpoint: human verification)*

Run: `make install && make restart`.
Human verifies on the Stream Deck +: hold-and-turn previews device names without audio switching per detent; release switches the output (SoundSource follows); plain press still toggles mute; plain rotate still changes volume. Known open question from the spec: whether SoundSource fights external default-output changes — if it reverts the switch, report back before proceeding.

- [ ] **Step 7: Run tests, then commit**

Run: `node --test test/model.test.js` — all pass.

```bash
git add com.sb.output-volume.sdPlugin/bin/plugin.js
git commit -m "Add press-and-turn output device switching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Custom layout, rate display, long-touch cycling

**Files:**
- Create: `com.sb.output-volume.sdPlugin/layouts/dial.json`
- Modify: `com.sb.output-volume.sdPlugin/manifest.json`
- Modify: `com.sb.output-volume.sdPlugin/bin/plugin.js`

**Interfaces:**
- Consumes: helper `rate`/`rates` device-event fields, `rate` event, `setrate` command (Task 4); `cycle`, `formatRate` (Task 1).
- Produces: dial screen shows the sample rate; long touch cycles it; short tap still mutes.

- [ ] **Step 1: Create the layout** — `layouts/dial.json` (200×100 canvas; reproduces `$B1` geometry plus a `rate` label; consult https://docs.elgato.com/streamdeck/sdk/references/layouts if items misrender):

```json
{
	"id": "sb-volume-dial",
	"items": [
		{ "key": "title", "type": "text", "rect": [16, 6, 168, 24], "font": { "size": 16, "weight": 600 }, "alignment": "center" },
		{ "key": "icon", "type": "pixmap", "rect": [16, 38, 28, 28] },
		{ "key": "value", "type": "text", "rect": [52, 36, 96, 32], "font": { "size": 24, "weight": 600 }, "alignment": "center" },
		{ "key": "rate", "type": "text", "rect": [148, 44, 44, 20], "font": { "size": 12, "weight": 500 }, "alignment": "right", "color": "#999999" },
		{ "key": "indicator", "type": "bar", "rect": [16, 76, 168, 12], "border_w": 0, "bar_bg_c": "0:#333333,1:#333333", "bar_fill_c": "#4da3ff" }
	]
}
```

- [ ] **Step 2: Point the manifest at it** — in `manifest.json`, the action's Encoder block becomes:

```json
			"Encoder": {
				"layout": "layouts/dial.json",
				"TriggerDescription": {
					"Rotate": "Adjust volume",
					"Push": "Toggle mute · hold and turn to switch device",
					"Touch": "Toggle mute · long press to cycle sample rate"
				}
			},
```

- [ ] **Step 3: Track and render the rate** — in `bin/plugin.js`: extend the model import with `cycle` and `formatRate`; add `rate: null, rates: []` to the `state` object literal; in the `"device"` case of `handleEvent` add:

```js
			state.rate = ev.rate ?? null;
			state.rates = ev.rates ?? [];
```

add a new event case:

```js
		case "rate":
			state.rate = ev.hz;
			break;
```

and in `feedbackPayload`, add to the returned object:

```js
		rate: state.rate == null ? "" : formatRate(state.rate),
```

- [ ] **Step 4: Long-touch cycles the rate** — in the `VolumeDial` class, replace `onTouchTap`:

```js
	onTouchTap(ev) {
		if (ev.payload.hold && state.rates.length > 1) {
			const next = state.rates[cycle(state.rates.length, state.rates.indexOf(state.rate), 1)];
			send(`setrate ${next}`);
			return;
		}
		this.#toggleMute();
	}
```

- [ ] **Step 5: Verify with the harness**

Run: `node tools/harness.mjs`, then: `hold`, then `tap`, then `tap`, then `quit`.
Expected: `hold` sends a real `setrate` — the next `setFeedback` (from the helper's rate event) shows the next rate label (e.g. `"rate":"44.1k"`); the two `tap`s toggle mute off/on as before. Repeat `hold` until the rate cycles back to its original value (it wraps), so the device ends where it started.

- [ ] **Step 6: Deploy and hardware-check** *(checkpoint: human verification)*

Run: `make install && make restart`.
Human verifies: the dial screen still resembles the stock layout (name, %, bar, icon) with a small rate label; long-touch cycles the rate (SoundSource's Sample Rate readout follows); short tap mutes. If the custom layout renders wrong and iteration doesn't fix it, fallback per spec: revert `layout` to `"$B1"` and append the rate to the title (`title: \`${state.name} · ${formatRate(state.rate)}\``).

- [ ] **Step 7: Run tests, then commit**

Run: `node --test test/model.test.js` — all pass.

```bash
git add com.sb.output-volume.sdPlugin/layouts/dial.json com.sb.output-volume.sdPlugin/manifest.json com.sb.output-volume.sdPlugin/bin/plugin.js
git commit -m "Show sample rate on dial; long-touch cycles it

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and push

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–7.

- [ ] **Step 1: Update the README** — in the Controls section of `README.md`, replace the bullet list with:

```markdown
- **Rotate** — volume up/down, one native step (6.25%) per detent
- **Press / touch** — toggle mute
- **Hold + turn** — preview output devices; release to switch
- **Long touch** — cycle the device's sample rate
- On non-dial decks the same action works as a key: volume as the
  title, press to mute
```

and add to the Known limits section:

```markdown
- Switching devices or sample rates briefly interrupts audio (a
  CoreAudio property change; unavoidable).
```

- [ ] **Step 2: Final check and push**

Run: `node --test test/model.test.js` (all pass) and `git status --short` (clean except README).

```bash
git add README.md
git commit -m "Document device switching, sample rate, and keypad features

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

---

## Self-Review Notes

- Spec coverage: press-and-turn (Tasks 2, 3, 6), sample rate (Tasks 1, 4, 7), keypad (Task 5), docs (Task 8). Mute-on-dial-up semantics from the spec are implemented in Task 6 Step 4.
- Type consistency: `pressTracker` actions (`preview`/`switch`/`mute`/`none`) match between Task 2 and Task 6; helper events `devices`/`rate` match between Tasks 3–4 and 6–7; `formatRate`/`cycle` signatures match Tasks 1 and 7.
- Open risks flagged inline: SoundSource fighting default-output changes (Task 6 checkpoint), custom-layout schema drift (Task 7 fallback), `touchTap.hold` availability (verified via harness in Task 7 Step 5 before hardware).
