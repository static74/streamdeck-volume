# Output Volume — Stream Deck plugin

Shows the macOS default output device's name and volume on a Stream
Deck + dial, and adjusts it. Built for setups where SoundSource 6
(ARK) applies volume in software and the stock Elgato volume dial
shows nothing.

## How it works

- Devices with a real CoreAudio volume control (built-in speakers,
  AirPods, USB mics) are read and written directly. Always live.
- Devices without one (pure DACs, monitors over DisplayPort) get
  SoundSource's software gain. The plugin drives it with synthesized
  media keys and tracks the level itself: seeded from SoundSource's
  saved prefs, updated by every volume key it observes — its own and
  your keyboard's.

## Controls

- Rotate: volume up/down, 6.25% (one native step) per detent.
- Press or touch: toggle mute.

## Install

```sh
make install   # builds the Swift helper, installs npm deps, symlinks the plugin
make restart   # restarts the Stream Deck app
```

Then drag "Output Volume" onto a dial.

**Permission**: the Stream Deck app needs Accessibility access to post
media keys (System Settings → Privacy & Security → Accessibility →
enable "Stream Deck"). The dial shows "No access" until granted.

## Known limits

- Volume moves on the native 1/16 grid (6.25% steps); arbitrary
  percentages aren't reachable through media keys.
- Dragging the slider inside SoundSource's own window isn't observable;
  the display drifts until the next plugin restart or device switch.
- SoundSource boost above 100% displays as 100%.
