# Stream Deck Output Volume — Design

Date: 2026-08-24. Status: approved.

## Problem

The stock Elgato volume dial reads CoreAudio volume properties. With
SoundSource 6 (ARK) active, the default output device (Benchmark DAC)
exposes no CoreAudio volume at all — SoundSource applies gain in
software. The stock plugin therefore shows nothing useful.

## Spike findings (verified on this machine)

- SoundSource 6 has no AppleScript dictionary.
- SoundSource ships App Intents, but invoking them requires saved
  shortcuts in Shortcuts.app. Rejected: user wants setup-free.
- Synthesized media-key events (volume up/down/mute) DO drive
  SoundSource's software gain. Verified by observation: 6 down-keys
  moved the SoundSource slider from 50% to 12.5%.
- Steps are the native 1/16 grid: 6.25% per key. SoundSource snaps to
  the grid on the first key press.
- SoundSource prefs (`com.rogueamoeba.soundsource`, key
  `deviceGroups.groups[].volumes[]`) hold per-device volume and mute.
  They do NOT update live; usable only as a startup baseline.
- No distributed notifications on volume change. No live read channel
  exists without Shortcuts.
- CoreAudio default-output name and change notifications work normally.
- Posting events requires Accessibility permission (attributed to the
  Stream Deck app as the responsible process).

## Decisions

- Dial step is 6.25% per detent, not the requested 5%. Media keys move
  on the 1/16 grid; 5% is unreachable. Approved by user.
- Display drift when the user drags SoundSource's own slider is
  accepted for v1. Re-baseline happens on plugin restart or device
  switch. Approved by user.
- Architecture is the Elgato Node.js SDK plus a small compiled Swift
  helper. Approved by user.

## Components

- `com.sb.output-volume.sdPlugin` — plugin bundle: manifest (one
  Encoder action, `$B1` layout), icons, plugin JS, compiled helper.
- Node plugin (plain JS, `@elgato/streamdeck`, no bundler; ships
  `node_modules`). Owns the volume model and renders the dial screen.
- `helper/audioctl.swift` → `bin/audioctl`. Long-lived child process.
  JSON lines out; one-word commands in (`up`, `down`, `mute`,
  `setvol <f>`, `setmute <0|1>`). Emits: hello (accessibility + tap
  status), baseline (decoded SoundSource prefs), device (default
  output: name, uid, hasVolume, hasMute; re-emitted on change),
  vol/mute (CoreAudio listeners), key (every media key seen by its
  event tap).

## Volume model

Per current default output device, one of two modes:

- **Native mode** (device has a CoreAudio volume control): read, write,
  and listen via CoreAudio (`kAudioDevicePropertyVirtualMainVolume`).
  Always live. Key events from the tap are ignored (CoreAudio listener
  already reports the change).
- **SoundSource mode** (no volume control): the plugin owns the number.
  Seed from prefs baseline (assume 100% if absent). Every volume key
  the tap sees — plugin-posted or physical keyboard — moves the model
  ±1/16 with grid snap: `steps = round(vol*16) + delta`, clamp 0–16.
  Mute key (non-repeat) toggles the mute flag. Volume keys while muted
  unmute first.

The model updates ONLY from helper events. Dial handlers just send
commands; the resulting event updates the model. One code path, no
double counting.

## Dial behavior

- Rotate: one 6.25% step per detent. N ticks → N media keys
  (SoundSource mode) or one CoreAudio set of ±N steps (native mode).
- Press and touchscreen tap: toggle mute.

## Display

Stock `$B1` layout: icon, device name title, `NN%` value, bar.
Muted: value "Muted", muted icon, bar keeps last volume.
Unknown volume (SoundSource mode, SoundSource not running): value "—".
Device name follows the default output automatically.

## Errors and edges

- Accessibility missing: helper reports it; action shows alert state;
  README documents the checkbox.
- SoundSource not running with a controller-less device: show "—".
- Boost (>100%) is ignored; display clamps to 100%.

## Testing

- Model logic (grid snap, clamp, mute, unmute-on-volume-key) in
  `node:test`.
- `audioctl` run standalone prints baseline + device: manual self-check.
- End-to-end verified by hand on the Stream Deck + hardware.
