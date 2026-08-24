# Output Volume — Stream Deck plugin for macOS

A Stream Deck plugin that shows the current macOS output device's name
and volume, and controls it — best on a Stream Deck + dial —
**including setups where SoundSource (ARK) applies volume in software
and the stock Elgato volume dial shows nothing**.

```
┌─────────────────────────┐
│ 🔊  Benchmark 1.0       │
│         81%             │
│  ███████████████░░░░    │
└─────────────────────────┘
```

- **Rotate** — volume up/down, one native step (6.25%) per detent
- **Press / touch** — toggle mute
- **Hold + turn** — preview output devices; release to switch
- **Long touch** — cycle the device's sample rate
- On button-only decks the same action works as a key: volume as the
  title, press to mute (device switching and rate cycling are dial-only)

## Why this exists

The stock volume dial reads CoreAudio's volume properties. Many devices
— pure DACs, DisplayPort monitors — expose no volume control at all, so
macOS (and the stock plugin) can't adjust or even display their volume.
[SoundSource](https://rogueamoeba.com/soundsource/) solves the control
half by applying gain in software, but that volume lives only inside
its audio daemon: there is no API, no AppleScript (removed in
SoundSource 6), and its preferences file is never updated with the live
value. The stock plugin shows a blank; this plugin shows the truth.

## How it works

Per device, the plugin picks one of two modes:

- **Native mode** — the device has a real CoreAudio volume control
  (built-in speakers, AirPods, most USB audio). Read, write, and listen
  via CoreAudio. Always live, never drifts.
- **SoundSource mode** — no CoreAudio control exists. The plugin posts
  synthesized media-key events, which SoundSource's Super Volume Keys
  feature turns into software gain. Since nothing can read that volume
  back, the plugin tracks it: a CGEvent tap observes every volume key —
  its own and your keyboard's — and moves the model in lockstep with
  what SoundSource actually does (verified: exactly 1/16 per press,
  snapped to the native grid). The level is persisted per device in
  `~/Library/Application Support/com.sb.output-volume/state.json` so
  restarts come back aligned.

A small compiled Swift helper (`audioctl`) does the system work and
streams JSON events to the Node plugin, which owns the model and renders
the dial with a custom dial layout modeled on Elgato's stock look
(name, %, bar, plus a sample-rate label).

The device name, volume, and sample rate follow the default output
automatically.

## Requirements

- macOS 12+ (built and tested on macOS 26 with SoundSource 6.1)
- Stream Deck app 6.5+ and a Stream Deck (best on a Stream Deck + —
  the dial carries volume, device switching, and rate cycling; on
  button-only decks the action shows volume on a key and mutes on
  press)
- Xcode Command Line Tools (`swiftc`) and Node.js/npm to build
- SoundSource is only needed for devices without hardware volume, with
  its volume-keys option enabled (Settings → Super Volume Keys)

## Install

```sh
git clone https://github.com/static74/streamdeck-volume.git
cd streamdeck-volume
make install   # compiles the helper, installs npm deps, symlinks the plugin
make restart   # restarts the Stream Deck app
```

Drag **Output Volume** onto a dial.

**Permission**: posting media keys requires Accessibility access for
the Stream Deck app (System Settings → Privacy & Security →
Accessibility → enable "Stream Deck"). The dial shows "No access"
until granted. Native-mode devices work without it.

## Known limits

- Volume moves on the native 1/16 grid (6.25% per detent); arbitrary
  percentages aren't reachable through media keys.
- Dragging the slider inside SoundSource's own window isn't observable;
  the display drifts until the next plugin restart or device switch.
  (Fixing this properly would require SoundSource's Shortcuts actions —
  a one-time Shortcuts.app setup this plugin deliberately avoids.)
- SoundSource boost above 100% displays as 100%.
- Switching devices or sample rates briefly interrupts audio (a
  CoreAudio property change; unavoidable).

## Development

```sh
make test      # model unit tests (node --test)
make helper    # rebuild the Swift helper only
```

Design notes and the investigation that shaped them live in
[`docs/superpowers/specs/`](docs/superpowers/specs/).
