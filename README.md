<img width="1920" height="1080" alt="Screenshot 2026-10-15 at 2 39 44 PM" src="https://github.com/user-attachments/assets/8db4f176-32b5-4012-bae0-3137fb8cba76" />

# Relay — two-way OSC MIDI

A Vite + TypeScript application for exchanging MIDI notes with another computer over OSC/UDP. Both musicians run the same app. Relay can send test notes, receive and audition incoming notes, and transmit the note events from a MIDI file at a configurable tempo.

The browser UI talks to a local Node bridge because browsers cannot open arbitrary UDP sockets. The bridge uses [`osc-js`](https://github.com/adzialocha/osc-js) for OSC networking and [`@tonejs/midi`](https://github.com/Tonejs/Midi) for MIDI-file parsing. Nothing is routed through a cloud service.

## Run it on both computers

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. This command starts both the Vite UI and the local UDP bridge.

For a production build:

```bash
npm run build
npm start
```

Then open <http://127.0.0.1:8787>.

## Connect the two copies

Relay displays its LAN address and listening port in the **Your receiver** panel. The default listening port is `9001`.

1. Each person shares the displayed address and port with the other person.
2. Enter the other person's address under **Your friend**.
3. Leave the OSC address as `/midi` on both computers.
4. Allow incoming UDP traffic if the operating-system firewall asks.
5. Send a test note in both directions.

For example:

```text
Computer A displays 10.0.0.12:9001 → enter this under Your friend on Computer B
Computer B displays 10.0.0.27:9001 → enter this under Your friend on Computer A
```

Both computers must be on a network that permits peer-to-peer traffic. Guest Wi-Fi networks sometimes enable client isolation and block communication between devices.

## Incoming monitor

Incoming notes appear in the live monitor and activity log. Click **Audio monitor off** to enable a lightweight browser synthesizer for received notes. Browsers require this click before they permit audio playback.

The supplied [`supercollider/receiver.scd`](supercollider/receiver.scd) remains available as a standalone SuperCollider receiver. It is not required for the two-way browser monitor.

## MIDI-file transmission

Choose or drop a `.mid` file, select a tempo from 20–400 BPM, then click **Send file**. Relay:

- preserves note tick positions, durations, velocities, tracks, and MIDI channels;
- re-times those ticks to one fixed configurable tempo;
- sends note-on and note-off events through the same `/midi` OSC route;
- supports polyphonic files; and
- sends cleanup note-offs when playback is stopped.

Tempo maps, control changes, pitch bends, program changes, lyrics, and SysEx events are not transmitted in this version.

## OSC message format

Relay sends each MIDI channel message as three OSC int32 arguments:

```text
/midi  <status byte>  <note>  <velocity>
```

For channel 1, middle C, velocity 100:

```text
/midi  144  60  100   # note-on
/midi  128  60  0     # note-off
```

MIDI channels are shown as 1–16 in the UI and encoded as 0–15 in the status byte.

Destination and listener settings are stored only in browser local storage. UDP has no delivery acknowledgement, so “sent” means the local socket dispatched the packet; the incoming activity log on the other computer is the delivery confirmation.
