// audioctl — CoreAudio + media-key helper for the output-volume plugin.
// Emits JSON lines on stdout; takes one-word commands on stdin:
//   up | down | mute | setvol <0..1> | setmute <0|1>
import Cocoa
import CoreAudio
import AudioToolbox

let printLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    printLock.lock()
    print(line)
    fflush(stdout)
    printLock.unlock()
}

// MARK: - CoreAudio

func addr(_ selector: AudioObjectPropertySelector,
          scope: AudioObjectPropertyScope = kAudioDevicePropertyScopeOutput) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope,
                               mElement: kAudioObjectPropertyElementMain)
}

func defaultOutputDevice() -> AudioDeviceID {
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var a = addr(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &id)
    return id
}

func deviceString(_ dev: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String {
    var a = addr(selector, scope: kAudioObjectPropertyScopeGlobal)
    var cf: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    _ = withUnsafeMutablePointer(to: &cf) { p in
        AudioObjectGetPropertyData(dev, &a, 0, nil, &size, p)
    }
    return cf as String
}

func hasProperty(_ dev: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> Bool {
    var a = addr(selector)
    return AudioObjectHasProperty(dev, &a)
}

func getVolume(_ dev: AudioDeviceID) -> Float32? {
    var a = addr(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    var v = Float32(0)
    var size = UInt32(MemoryLayout<Float32>.size)
    return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &v) == noErr ? v : nil
}

func setVolume(_ dev: AudioDeviceID, _ v: Float32) {
    var a = addr(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    var vol = min(max(v, 0), 1)
    AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<Float32>.size), &vol)
}

func getMute(_ dev: AudioDeviceID) -> Bool? {
    var a = addr(kAudioDevicePropertyMute)
    var m = UInt32(0)
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(dev, &a, 0, nil, &size, &m) == noErr ? m == 1 : nil
}

func setMute(_ dev: AudioDeviceID, _ m: Bool) {
    var a = addr(kAudioDevicePropertyMute)
    var val = UInt32(m ? 1 : 0)
    AudioObjectSetPropertyData(dev, &a, 0, nil, UInt32(MemoryLayout<UInt32>.size), &val)
}

// MARK: - SoundSource baseline

// Keyed by device NAME, main group only, first entry wins: device UIDs embed
// USB location ids that drift between replugs, and SoundSource's user-created
// output groups carry stale duplicate entries.
func emitBaseline() {
    var volumes: [String: Any] = [:]
    guard let dg = CFPreferencesCopyAppValue("deviceGroups" as CFString,
                                             "com.rogueamoeba.soundsource" as CFString) as? [String: Any],
          let group = (dg["groups"] as? [[String: Any]])?.first else {
        emit(["e": "baseline", "volumes": volumes])
        return
    }
    for entry in (group["volumes"] as? [[String: Any]] ?? []) {
        guard let blob = entry["device"] as? Data,
              let s = String(data: blob, encoding: .utf8),
              let jsonStart = s.range(of: ":")?.upperBound,
              let dev = try? JSONSerialization.jsonObject(with: Data(s[jsonStart...].utf8)) as? [String: Any],
              let name = dev["n"] as? String, !name.isEmpty,
              volumes[name] == nil else { continue }
        volumes[name] = ["v": entry["volume"] as? Double ?? 1.0,
                         "m": entry["muted"] as? Bool ?? false]
    }
    emit(["e": "baseline", "volumes": volumes])
}

// MARK: - Media keys

// NX_KEYTYPE_SOUND_UP = 0, NX_KEYTYPE_SOUND_DOWN = 1, NX_KEYTYPE_MUTE = 7
func postMediaKey(_ key: Int32) {
    for down in [true, false] {
        let flags: UInt = down ? 0xa00 : 0xb00
        let data1 = Int((Int32(key) << 16) | Int32((down ? 0x0a : 0x0b) << 8))
        guard let ev = NSEvent.otherEvent(
            with: .systemDefined, location: .zero,
            modifierFlags: NSEvent.ModifierFlags(rawValue: flags),
            timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: 0, context: nil,
            subtype: 8, data1: data1, data2: -1) else { return }
        ev.cgEvent?.post(tap: .cghidEventTap)
    }
}

// MARK: - Device state + listeners

let listenerQueue = DispatchQueue(label: "audioctl.listeners")
var currentDevice = AudioDeviceID(0)
var volListener: AudioObjectPropertyListenerBlock?
var muteListener: AudioObjectPropertyListenerBlock?

func emitDevice(_ dev: AudioDeviceID) {
    let hv = hasProperty(dev, kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    let hm = hasProperty(dev, kAudioDevicePropertyMute)
    var obj: [String: Any] = [
        "e": "device",
        "name": deviceString(dev, kAudioObjectPropertyName),
        "uid": deviceString(dev, kAudioDevicePropertyDeviceUID),
        "hasVolume": hv,
        "hasMute": hm,
    ]
    if hv, let v = getVolume(dev) { obj["v"] = Double(v) }
    if hm, let m = getMute(dev) { obj["m"] = m }
    emit(obj)
}

func attachDeviceListeners(_ dev: AudioDeviceID) {
    var volAddr = addr(kAudioHardwareServiceDeviceProperty_VirtualMainVolume)
    var muteAddr = addr(kAudioDevicePropertyMute)
    if currentDevice != 0 {
        if let vl = volListener {
            AudioObjectRemovePropertyListenerBlock(currentDevice, &volAddr, listenerQueue, vl)
        }
        if let ml = muteListener {
            AudioObjectRemovePropertyListenerBlock(currentDevice, &muteAddr, listenerQueue, ml)
        }
    }
    currentDevice = dev
    volListener = nil
    muteListener = nil
    if hasProperty(dev, kAudioHardwareServiceDeviceProperty_VirtualMainVolume) {
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            if let v = getVolume(dev) { emit(["e": "vol", "v": Double(v)]) }
        }
        AudioObjectAddPropertyListenerBlock(dev, &volAddr, listenerQueue, block)
        volListener = block
    }
    if hasProperty(dev, kAudioDevicePropertyMute) {
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            if let m = getMute(dev) { emit(["e": "mute", "m": m]) }
        }
        AudioObjectAddPropertyListenerBlock(dev, &muteAddr, listenerQueue, block)
        muteListener = block
    }
}

func handleDeviceChange() {
    let dev = defaultOutputDevice()
    guard dev != currentDevice else { return }
    attachDeviceListeners(dev)
    emitDevice(dev)
}

// MARK: - Event tap

func startTap() -> Bool {
    let mask = CGEventMask(1 << 14) // NX_SYSDEFINED
    guard let tap = CGEvent.tapCreate(
        tap: .cghidEventTap, place: .headInsertEventTap,
        options: .listenOnly, eventsOfInterest: mask,
        callback: { _, _, event, _ in
            if let ns = NSEvent(cgEvent: event), ns.subtype.rawValue == 8 {
                let keyCode = (ns.data1 & 0xFFFF0000) >> 16
                let keyFlags = ns.data1 & 0xFFFF
                let isDown = ((keyFlags & 0xFF00) >> 8) == 0xA
                let isRepeat = (keyFlags & 0x1) == 1
                if isDown {
                    let name: String?
                    switch keyCode {
                    case 0: name = "up"
                    case 1: name = "down"
                    case 7: name = "mute"
                    default: name = nil
                    }
                    if let name {
                        emit(["e": "key", "k": name, "repeat": isRepeat])
                    }
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: nil) else { return false }
    let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    return true
}

// MARK: - Output device switching

func outputDevices() -> [(id: AudioDeviceID, name: String, uid: String)] {
    var a = addr(kAudioHardwarePropertyDevices, scope: kAudioObjectPropertyScopeGlobal)
    var size = UInt32(0)
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size) == noErr,
          size > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &ids) == noErr
        else { return [] }
    return ids.filter { dev in
        // output-capable = has at least one output-scope stream
        var sa = addr(kAudioDevicePropertyStreams)
        var ssize = UInt32(0)
        AudioObjectGetPropertyDataSize(dev, &sa, 0, nil, &ssize)
        return ssize > 0
    }.map { ($0, deviceString($0, kAudioObjectPropertyName), deviceString($0, kAudioDevicePropertyDeviceUID)) }
}

func emitDeviceList() {
    let devs = outputDevices().map { ["name": $0.name, "uid": $0.uid] }
    emit(["e": "devices", "devices": devs])
}

func setDefaultOutput(uid: String) {
    guard let dev = outputDevices().first(where: { $0.uid == uid })?.id else { return }
    var a = addr(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
    var id = dev
    AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil,
                               UInt32(MemoryLayout<AudioDeviceID>.size), &id)
}

// MARK: - Main

let tapOK = startTap()
emit(["e": "hello", "ax": AXIsProcessTrusted(), "tap": tapOK])
emitBaseline()

var defaultAddr = addr(kAudioHardwarePropertyDefaultOutputDevice, scope: kAudioObjectPropertyScopeGlobal)
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultAddr, listenerQueue) { _, _ in
    handleDeviceChange()
}

let initial = defaultOutputDevice()
attachDeviceListeners(initial)
emitDevice(initial)

DispatchQueue.global().async {
    while let line = readLine() {
        let parts = line.split(separator: " ")
        guard let cmd = parts.first else { continue }
        switch cmd {
        case "up": postMediaKey(0)
        case "down": postMediaKey(1)
        case "mute": postMediaKey(7)
        case "setvol":
            if parts.count > 1, let v = Float32(parts[1]) { setVolume(currentDevice, v) }
        case "setmute":
            if parts.count > 1 { setMute(currentDevice, parts[1] == "1") }
        case "baseline": emitBaseline()
        case "list": emitDeviceList()
        case "setdefault":
            let uid = String(line.dropFirst("setdefault ".count))
            if !uid.isEmpty { setDefaultOutput(uid: uid) }
        default: break
        }
    }
    exit(0) // parent closed stdin
}

RunLoop.main.run()
