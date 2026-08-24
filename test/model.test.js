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
