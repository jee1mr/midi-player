# midi.player

A browser-based MIDI player that sends note, pedal, and expression data to your piano over Bluetooth MIDI. Built for the Kawai CA series but works with any MIDI output device.

**[jeevanmr.com/midi-player](https://jeevanmr.com/midi-player/)**

## Features

- Web MIDI API connection with device auto-detection
- Full MIDI data forwarding — notes, velocities, sustain/soft/sostenuto pedal, expression, pitch bend
- Timestamp-based lookahead scheduler for sub-millisecond precision
- Canvas piano roll visualization with scrolling playhead
- Built-in library of 1,276 virtuoso piano performances
- Transport controls: play/pause, stop, seek, tempo adjustment, volume
- Drag-and-drop for custom MIDI files

## Library

The built-in library uses the [MAESTRO Dataset v3](https://magenta.withgoogle.com/datasets/maestro) — virtuoso piano performances captured on Yamaha Disklaviers at the International Piano-e-Competition (2004–2018). Real human performances with full dynamics, rubato, and pedalling at ~3ms timing precision.

MAESTRO Dataset licensed under [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) by Google LLC.

## Requirements

- Chrome or Edge (Web MIDI API is not supported in Safari or Firefox)
- A MIDI output device connected via Bluetooth or USB
- On Mac: pair your piano via **Audio MIDI Setup → Window → Show MIDI Studio → Configure Bluetooth**

## Known Issues

- **Tab switching**: Chrome throttles background timers when the tab is not in focus. This can cause notes and pedal events to be delayed or dropped. Keep the tab in the foreground for best results.
- **Mobile**: Does not work on phones or tablets — Web MIDI API is desktop only.

## Credits

Created by [Jeevan M R](https://jeevanmr.com) with the help of Claude Opus 4.6.
