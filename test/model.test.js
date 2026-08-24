import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKey, stepVolume } from "../com.sb.output-volume.sdPlugin/bin/model.js";

test("steps snap to the 1/16 grid (observed SoundSource behavior)", () => {
	// 49.9% baseline + one down-key -> 43.75%, matching the live spike result
	assert.equal(stepVolume(0.49912793380409154, -1), 0.4375);
	// six down-keys from ~50% landed on 12.5% on the real machine
	let v = 0.49912793380409154;
	for (let i = 0; i < 6; i++) v = stepVolume(v, -1);
	assert.equal(v, 0.125);
});

test("clamps at 0 and 1", () => {
	assert.equal(stepVolume(0.03, -1), 0);
	assert.equal(stepVolume(0, -1), 0);
	assert.equal(stepVolume(0.97, 1), 1);
	assert.equal(stepVolume(1, 1), 1);
});

test("multi-tick steps apply in one call", () => {
	assert.equal(stepVolume(0.5, 3), 0.6875);
	assert.equal(stepVolume(0.5, -3), 0.3125);
});

test("mute key toggles without touching volume", () => {
	const muted = applyKey({ volume: 0.5, muted: false }, "mute");
	assert.deepEqual(muted, { volume: 0.5, muted: true });
	assert.deepEqual(applyKey(muted, "mute"), { volume: 0.5, muted: false });
});

test("volume keys unmute", () => {
	const next = applyKey({ volume: 0.5, muted: true }, "up");
	assert.equal(next.muted, false);
	assert.equal(next.volume, 0.5625);
});

test("unknown baseline assumes SoundSource's 100% default", () => {
	const next = applyKey({ volume: null, muted: false }, "down");
	assert.equal(next.volume, 0.9375);
});

test("seed prefers own store over stale prefs over default", async () => {
	const { seedVolume } = await import("../com.sb.output-volume.sdPlugin/bin/model.js");
	const store = { Bench: { v: 0.8125, m: false } };
	const prefs = { Bench: { v: 0.4991, m: false }, Other: { v: 0.25, m: true } };
	// the original bug: prefs said 49.9% while truth was 81.25%
	assert.equal(seedVolume("Bench", store, prefs).volume, 0.8125);
	assert.deepEqual(seedVolume("Other", store, prefs), { volume: 0.25, muted: true });
	assert.deepEqual(seedVolume("New Device", store, prefs), { volume: 1, muted: false });
});

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
