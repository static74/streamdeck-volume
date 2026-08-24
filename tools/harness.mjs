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
