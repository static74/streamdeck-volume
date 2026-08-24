import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyKey, stepVolume } from "./model.js";

const logger = streamDeck.logger.createScope("output-volume");

const state = {
	mode: "ss", // "native" (CoreAudio volume control) | "ss" (SoundSource software gain)
	name: "",
	volume: null,
	muted: false,
	baseline: {}, // device name -> { v, m } from SoundSource prefs
	ax: true,
	ssRunning: true,
};

let helper = null;

function send(cmd) {
	if (helper?.stdin.writable) helper.stdin.write(cmd + "\n");
}

function checkSoundSourceRunning() {
	execFile("/usr/bin/pgrep", ["-x", "SoundSource"], (err) => {
		state.ssRunning = !err;
		render();
	});
}

function handleEvent(ev) {
	switch (ev.e) {
		case "hello":
			state.ax = ev.ax && ev.tap;
			if (!state.ax) logger.warn("Accessibility not granted; media keys unavailable");
			break;
		case "baseline":
			state.baseline = ev.volumes;
			break;
		case "device": {
			state.name = ev.name;
			state.mode = ev.hasVolume ? "native" : "ss";
			if (state.mode === "native") {
				state.volume = ev.v ?? null;
				state.muted = ev.m ?? false;
			} else {
				const seed = state.baseline[ev.name];
				state.volume = seed ? Math.min(seed.v, 1) : 1;
				state.muted = seed ? seed.m : false;
				checkSoundSourceRunning();
			}
			break;
		}
		case "vol":
			if (state.mode === "native") state.volume = ev.v;
			break;
		case "mute":
			if (state.mode === "native") state.muted = ev.m;
			break;
		case "key": {
			if (state.mode !== "ss") break; // native mode: CoreAudio listener reports it
			if (ev.k === "mute" && ev.repeat) break;
			const next = applyKey(state, ev.k);
			state.volume = next.volume;
			state.muted = next.muted;
			break;
		}
	}
	render();
}

function startHelper() {
	const bin = join(dirname(fileURLToPath(import.meta.url)), "audioctl");
	helper = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
	createInterface({ input: helper.stdout }).on("line", (line) => {
		try {
			handleEvent(JSON.parse(line));
		} catch (err) {
			logger.error(`bad helper line: ${line} (${err})`);
		}
	});
	helper.on("exit", (code) => {
		logger.warn(`audioctl exited (${code}); respawning in 2s`);
		helper = null;
		setTimeout(startHelper, 2000);
	});
}

function feedbackPayload() {
	const pct = state.volume == null ? null : Math.round(state.volume * 100);
	let value;
	if (!state.ax) value = "No access";
	else if (state.mode === "ss" && !state.ssRunning) value = "—";
	else if (state.muted) value = "Muted";
	else value = pct == null ? "—" : `${pct}%`;
	return {
		title: state.name || "Output",
		value,
		indicator: { value: pct ?? 0 },
		icon: state.muted ? "imgs/muted" : "imgs/speaker",
	};
}

function render() {
	const payload = feedbackPayload();
	for (const a of dial.actions) {
		a.setFeedback(payload);
	}
}

class VolumeDial extends SingletonAction {
	onWillAppear() {
		render();
	}

	onDialRotate(ev) {
		const ticks = ev.payload.ticks;
		if (ticks === 0) return;
		if (state.mode === "native") {
			if (state.volume == null) return;
			send(`setvol ${stepVolume(state.volume, ticks)}`);
		} else {
			const key = ticks > 0 ? "up" : "down";
			for (let i = 0; i < Math.abs(ticks); i++) send(key);
		}
	}

	onDialDown() {
		this.#toggleMute();
	}

	onTouchTap() {
		this.#toggleMute();
	}

	#toggleMute() {
		if (state.mode === "native") {
			send(`setmute ${state.muted ? 0 : 1}`);
		} else {
			send("mute");
		}
	}
}

const dial = new (action({ UUID: "com.sb.output-volume.dial" })(VolumeDial))();
streamDeck.actions.registerAction(dial);
startHelper();
streamDeck.connect();
