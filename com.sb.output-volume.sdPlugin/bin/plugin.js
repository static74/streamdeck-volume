import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyKey, pressTracker, seedVolume, stepVolume } from "./model.js";

const logger = streamDeck.logger.createScope("output-volume");

// Last-known volume per device, persisted by us. SoundSource's live volume
// exists only in its daemon's memory, so this file is the best baseline.
const STATE_DIR = join(homedir(), "Library", "Application Support", "com.sb.output-volume");
const STATE_FILE = join(STATE_DIR, "state.json");

function loadStore() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return {};
	}
}

let saveTimer = null;
function saveStore() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			mkdirSync(STATE_DIR, { recursive: true });
			writeFileSync(STATE_FILE, JSON.stringify(store));
		} catch (err) {
			logger.error(`state save failed: ${err}`);
		}
	}, 500);
}

const store = loadStore();

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

const press = pressTracker();
let deviceList = []; // [{ name, uid }] — refreshed at startup and on device change

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
			send("list");
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
				const seed = seedVolume(ev.name, store, state.baseline);
				state.volume = seed.volume;
				state.muted = seed.muted;
				checkSoundSourceRunning();
			}
			send("list");
			break;
		}
		case "devices":
			deviceList = ev.devices;
			break;
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
			if (state.name) {
				store[state.name] = { v: state.volume, m: state.muted };
				saveStore();
			}
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
		if (typeof a.setFeedback === "function") {
			a.setFeedback(payload);
		} else {
			a.setTitle(payload.value);
			a.setImage(state.muted ? "imgs/muted.svg" : "imgs/speaker.svg");
		}
	}
}

function renderPreview(device) {
	if (!device) return;
	const payload = { title: `→ ${device.name}`, value: "release to switch" };
	for (const a of dial.actions) {
		if (typeof a.setFeedback === "function") a.setFeedback(payload);
	}
}

class VolumeDial extends SingletonAction {
	onWillAppear() {
		render();
	}

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

	onTouchTap() {
		this.#toggleMute();
	}

	onKeyDown() {
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
