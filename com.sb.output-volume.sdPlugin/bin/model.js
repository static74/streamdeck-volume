// Volume arithmetic for SoundSource mode: media keys move on the native
// 1/16 grid, and SoundSource snaps to the grid on the first key press.

export function stepVolume(vol, deltaSteps) {
	const steps = Math.round(vol * 16) + deltaSteps;
	return Math.min(16, Math.max(0, steps)) / 16;
}

// Seed priority: our own persisted state (accurate as of last run) beats
// SoundSource's prefs (stale — the live value never reaches disk), beats
// SoundSource's 100% default for unseen devices.
export function seedVolume(name, store, prefsBaseline) {
	const own = store[name];
	if (own) return { volume: Math.min(own.v, 1), muted: !!own.m };
	const prefs = prefsBaseline[name];
	if (prefs) return { volume: Math.min(prefs.v, 1), muted: !!prefs.m };
	return { volume: 1, muted: false };
}

// state: { volume: number|null, muted: boolean }
// key: "up" | "down" | "mute" (mute already repeat-filtered by caller)
export function applyKey(state, key) {
	if (key === "mute") {
		return { volume: state.volume, muted: !state.muted };
	}
	const vol = state.volume ?? 1; // no baseline: SoundSource defaults new devices to 100%
	return { volume: stepVolume(vol, key === "up" ? 1 : -1), muted: false };
}

// Wrapping index cycling, shared by device switching and rate cycling.
export function cycle(length, index, delta) {
	if (length === 0) return -1;
	return (((index + delta) % length) + length) % length;
}

export function formatRate(hz) {
	const k = hz / 1000;
	return (Number.isInteger(k) ? k : k.toFixed(1)) + "k";
}
