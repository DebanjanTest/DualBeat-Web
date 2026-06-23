let audioContext = null;
let audioElement = null;
let audioSourceNode = null;
let pannerNode = null;

let isUnlocked = false;
let currentChannel = 'stereo';
let compensationMs = 0;
let useSpatialEngine = true;
let waveAngle = 0;
let leaderBaseUrl = '';

window.currentTrackTitle = '';

// Expose functions to window for onclick handlers
window.playDeviceTestTone = playDeviceTestTone;
window.toggleEngine = toggleEngine;
window.unlockAudioContext = unlockAudioContext;
window.setChannel = setChannel;
window.updateCalibration = updateCalibration;

function autoUnmuteAll() {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("AudioContext resumed cleanly via background listener.");
        });
    }
}
window.addEventListener('click', autoUnmuteAll);
window.addEventListener('touchstart', autoUnmuteAll);
window.addEventListener('keydown', autoUnmuteAll);

function playDeviceTestTone() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.4);
        
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.7);
        
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.75);
        console.log("Audio system diagnostic sweep sound triggered.");
    } catch (e) {
        alert("Make sure your device side-mute switch is off and volume is up! Info: " + e.message);
    }
}

function toggleEngine(mode) {
    if (mode === 'spatial') {
        useSpatialEngine = true;
        document.getElementById('btn-engine-spatial').className = "engine-btn selected";
        document.getElementById('btn-engine-direct').className = "engine-btn";
        const indicator = document.getElementById('engine-badge');
        indicator.innerText = "Spatial On";
        indicator.className = "engine-indicator";
    } else {
        useSpatialEngine = false;
        document.getElementById('btn-engine-spatial').className = "engine-btn";
        document.getElementById('btn-engine-direct').className = "engine-btn selected-direct";
        const indicator = document.getElementById('engine-badge');
        indicator.innerText = "Ultra-Compat Direct";
        indicator.className = "engine-indicator direct";
    }
    
    if (isUnlocked) {
        teardownAudioRouting();
        rebuildAudioRouting();
    }
}

function teardownAudioRouting() {
    try {
        if (audioElement) {
            audioElement.pause();
        }
        if (audioSourceNode) {
            audioSourceNode.disconnect();
        }
        if (pannerNode) {
            pannerNode.disconnect();
        }
        audioSourceNode = null;
        pannerNode = null;
    } catch (e) {
        console.warn("Audio Context teardown error", e);
    }
}

function rebuildAudioRouting() {
    try {
        if (!audioElement) {
            audioElement = new Audio();
            audioElement.crossOrigin = "anonymous";
            // Wait for track title to be fetched to set the correct src
        }
        
        if (useSpatialEngine) {
            window.AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!audioContext) {
                audioContext = new AudioContext();
            }
            
            // Avoid re-creating MediaElementSource multiple times for same element
            if (!audioSourceNode) {
                audioSourceNode = audioContext.createMediaElementSource(audioElement);
            } else {
                audioSourceNode.disconnect();
            }
            
            if (audioContext.createStereoPanner) {
                if (!pannerNode) pannerNode = audioContext.createStereoPanner();
                else pannerNode.disconnect();
                audioSourceNode.connect(pannerNode);
                pannerNode.connect(audioContext.destination);
            } else {
                audioSourceNode.connect(audioContext.destination);
            }
            audioContext.resume();
            setChannel(currentChannel);
        } else {
            console.log("Direct-speaker mode activated. Bypassing Web Audio node routing.");
        }
        
        if (audioElement.src) {
            audioElement.play().catch(e => {
                console.warn("Awaiting initial tick playback gesture", e);
            });
        }
    } catch (e) {
        console.error("Rebuild audio routing error, fallback direct:", e);
        useSpatialEngine = false;
    }
}

function unlockAudioContext() {
    const ipInput = document.getElementById('host-ip').value.trim();
    if (!ipInput) {
        alert("Please enter the Leader IP address first!");
        return;
    }
    
    leaderBaseUrl = `http://${ipInput}:8080`;
    
    if (isUnlocked) return;
    
    rebuildAudioRouting();
    isUnlocked = true;
    
    // UI Updates
    document.getElementById('unlock-trigger').style.display = 'none';
    document.getElementById('connection-panel').style.display = 'none';
    document.getElementById('display-panel').style.display = 'block';
    
    document.getElementById('sync-status').innerText = 'Connected & Synced';
    document.getElementById('sync-status').classList.add('active');
    
    setChannel(currentChannel);
    
    startSyncLoop();
    animateWave();
}

function setChannel(channel) {
    currentChannel = channel;
    document.getElementById('btn-left').className = "channel-btn" + (channel === 'left' ? ' selected-left' : '');
    document.getElementById('btn-stereo').className = "channel-btn" + (channel === 'stereo' ? ' selected-stereo' : '');
    document.getElementById('btn-right').className = "channel-btn" + (channel === 'right' ? ' selected-right' : '');
    
    if (!pannerNode) return;
    
    if (channel === 'left') {
        pannerNode.pan.value = -1.0;
    } else if (channel === 'right') {
        pannerNode.pan.value = 1.0;
    } else {
        pannerNode.pan.value = 0.0;
    }
}

function updateCalibration(val) {
    compensationMs = parseInt(val);
    document.getElementById('cal-val').innerText = (compensationMs >= 0 ? "+" : "") + compensationMs + " ms";
}

async function startSyncLoop() {
    while (true) {
        try {
            const t0 = Date.now();
            const resp = await fetch(`${leaderBaseUrl}/status`);
            const data = await resp.json();
            const t1 = Date.now();
            
            const rtt = t1 - t0;
            const networkLatency = rtt / 2.0;
            
            const masterIsPlaying = data.isPlaying;
            const masterPos = data.trackPositionMs / 1000.0;
            const masterTitle = data.trackTitle;
            
            document.getElementById('track-title').innerText = masterTitle;
            if (audioElement && data.volume !== undefined) {
                audioElement.volume = parseFloat(data.volume);
            }
            
            if (window.currentTrackTitle !== masterTitle) {
                window.currentTrackTitle = masterTitle;
                if (audioElement) {
                    audioElement.src = `${leaderBaseUrl}/track_stream?t=` + encodeURIComponent(masterTitle);
                    audioElement.load();
                }
            }
            
            if (masterIsPlaying) {
                document.getElementById('sync-status').innerText = "CALIBRATED (RTT " + rtt + "ms)";
                document.getElementById('sync-status').className = "sync-badge active";
                
                const targetPos = masterPos + (networkLatency / 1000.0) + (compensationMs / 1000.0);
                const drift = Math.abs((audioElement.currentTime || 0) - targetPos);
                
                if (audioElement && audioElement.paused) {
                    audioElement.play().catch(e => {
                        document.getElementById('sync-status').innerText = "Tap card to resume audio";
                    });
                }
                
                if (audioElement && drift > 0.060) {
                    audioElement.currentTime = targetPos;
                }
            } else {
                document.getElementById('sync-status').innerText = "PAUSED BY LEADER";
                document.getElementById('sync-status').className = "sync-badge paused";
                if (audioElement && !audioElement.paused) {
                    audioElement.pause();
                }
            }
        } catch (error) {
            document.getElementById('sync-status').innerText = "RECONNECTING...";
            document.getElementById('sync-status').className = "sync-badge error";
        }
        await new Promise(r => setTimeout(r, 1200));
    }
}

function animateWave() {
    waveAngle += 0.06;
    const activeScale = (audioElement && !audioElement.paused) ? 1.0 : 0.15;
    
    let d1 = "M 0,30 ";
    let d2 = "M 0,30 ";
    
    for (let x = 0; x <= 400; x += 10) {
        const t = x / 400.0;
        const y1 = 30 + Math.sin(t * Math.PI * 2.5 - waveAngle) * 16 * activeScale;
        const y2 = 30 + Math.sin(t * Math.PI * 4.0 + waveAngle * 1.3) * 8 * activeScale;
        d1 += "L " + x + "," + y1 + " ";
        d2 += "L " + x + "," + y2 + " ";
    }
    
    document.getElementById('path1').setAttribute('d', d1);
    document.getElementById('path2').setAttribute('d', d2);
    
    requestAnimationFrame(animateWave);
}
