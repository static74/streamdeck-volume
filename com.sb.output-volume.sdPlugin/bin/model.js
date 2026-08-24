// Volume arithmetic for SoundSource mode: media keys move on the native
// 1/16 grid, and SoundSource snaps to the grid on the first key press.

export function stepVolume(vol, deltaSteps) {
	const steps = Math.round(vol * 16) + deltaSteps;
	return Math.min(16, Math.max(0, steps)) / 16;
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
