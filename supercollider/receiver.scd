// Relay friend-side receiver
//
// 1. Open this file in SuperCollider on the receiving computer.
// 2. Select this entire first block and evaluate it (Cmd+Enter on macOS,
//    Ctrl+Enter on Windows/Linux).
// 3. In Relay, use this computer's local IPv4 address and the UDP port
//    printed in SuperCollider's post window (normally 57120).

(
// Use the port this SuperCollider language process already owns. It is usually
// 57120, but SuperCollider selects another one if 57120 was occupied at launch.
~relayPort = NetAddr.langPort;

// Release any notes left behind if this setup block is evaluated again.
if(~relayNotes.notNil, {
    ~relayNotes.values.do({ |synth| synth.set(\gate, 0) });
});
~relayNotes = IdentityDictionary.new;

s.waitForBoot({
    // A small built-in confirmation sound; no samples or plugins are needed.
    SynthDef(\relayTone, {
        |out = 0, freq = 440, amp = 0.12, gate = 1, pan = 0|
        var envelope;
        var sound;

        envelope = EnvGen.kr(
            Env.adsr(attackTime: 0.01, decayTime: 0.08,
                sustainLevel: 0.72, releaseTime: 0.25),
            gate,
            doneAction: 2
        );
        sound = (SinOsc.ar(freq) * 0.8) +
            (VarSaw.ar(freq * 2, width: 0.35) * 0.2);
        sound = LPF.ar(sound, (freq * 5).clip(400, 12000));

        Out.ar(out, Pan2.ar(sound * envelope * amp, pan));
    }).add;

    s.sync;

    // Expected OSC message: /midi <status> <note> <velocity>
    OSCdef(\networkMidi, {
        |message, time, sender, receivePort|
        var status;
        var note;
        var velocity;
        var command;
        var channel;
        var key;
        var existingSynth;
        var amplitude;
        var pan;

        status = message[1].asInteger;
        note = message[2].asInteger.clip(0, 127);
        velocity = message[3].asInteger.clip(0, 127);

        // The high nibble is the MIDI command; the low nibble is channel 0-15.
        command = status.bitAnd(16rF0);
        channel = status.bitAnd(16r0F) + 1;
        key = (channel * 128) + note;

        // A note-on with velocity zero is also treated as note-off by MIDI.
        if((command == 16r90) and: { velocity > 0 }, {
            existingSynth = ~relayNotes[key];
            if(existingSynth.notNil, { existingSynth.set(\gate, 0) });

            amplitude = velocity.linlin(1, 127, 0.015, 0.16);
            pan = channel.linlin(1, 16, -0.55, 0.55);
            ~relayNotes[key] = Synth(\relayTone, [
                \freq, note.midicps,
                \amp, amplitude,
                \pan, pan
            ]);

            ["Relay note on", "channel", channel, "note", note,
                "velocity", velocity, "from", sender.ip].postln;
        }, {
            if((command == 16r80) or: {
                (command == 16r90) and: { velocity == 0 }
            }, {
                existingSynth = ~relayNotes.removeAt(key);
                if(existingSynth.notNil, { existingSynth.set(\gate, 0) });

                ["Relay note off", "channel", channel, "note", note,
                    "from", sender.ip].postln;
            }, {
                ["Relay ignored unsupported MIDI status", status,
                    "from", sender.ip].postln;
            });
        });
    }, '/midi', recvPort: ~relayPort);

    "Relay is ready: listening for /midi on UDP port %"
        .format(~relayPort).postln;
});

s.boot;
)

// Evaluate this second block when you want to stop the Relay receiver.
/*
(
OSCdef(\networkMidi).free;
~relayNotes.values.do({ |synth| synth.set(\gate, 0) });
~relayNotes.clear;
"Relay receiver stopped".postln;
)
*/
