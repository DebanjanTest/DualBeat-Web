let audioElement = null;
let ytPlayer = null;
let isUnlocked = false;
let compensationMs = 0;
let waveAngle = 0;
let leaderBaseUrl = '';
let currentMode = ''; // 'local', 'cloud_host', 'cloud_client'

// Cloud State
let mqttClient = null;
let roomCode = '';
let myClientId = Math.random().toString(36).substring(2, 10);
let clockOffset = 0; // Host Time - Local Time
let pingInterval = null;

let cloudState = {
    isPlaying: false,
    trackTitle: '',
    trackPositionMs: 0,
    timestamp: 0
};

window.currentTrackTitle = '';

// Expose functions to window
window.unlockAudioContext = unlockAudioContext;
window.hostCloudRoom = hostCloudRoom;
window.joinCloudRoom = joinCloudRoom;
window.updateCalibration = updateCalibration;
window.loadYouTubeVideo = loadYouTubeVideo;
window.toggleCloudPlayPause = toggleCloudPlayPause;
window.playDeviceTestTone = playDeviceTestTone;

// YouTube API Ready
window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('yt-player', {
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: { 'autoplay': 0, 'controls': 0, 'disablekb': 1, 'fs': 0, 'modestbranding': 1, 'rel': 0 },
        events: {
            'onReady': onPlayerReady
        }
    });
}

function onPlayerReady(event) {
    console.log("YouTube Player Ready");
}

function unlockAudioContext() {
    const ipInput = document.getElementById('host-ip').value.trim();
    if (!ipInput) {
        alert("Please enter the Leader IP address first!");
        return;
    }
    leaderBaseUrl = `http://${ipInput}:8080`;
    currentMode = 'local';
    
    startUI();
    startSyncLoop();
    animateWave();
}

function hostCloudRoom() {
    roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    currentMode = 'cloud_host';
    
    document.getElementById('display-room-code').innerText = roomCode;
    document.getElementById('host-panel').style.display = 'block';
    
    initMqtt();
    startUI();
    animateWave();
    
    // Host pulse loop
    setInterval(() => {
        if (cloudState.trackTitle.startsWith("YOUTUBE:") && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
            const state = ytPlayer.getPlayerState();
            cloudState.isPlaying = (state === 1);
            cloudState.trackPositionMs = Math.floor(ytPlayer.getCurrentTime() * 1000);
        }
        cloudState.timestamp = Date.now();
        publishCloudState();
    }, 1000);
}

function joinCloudRoom() {
    const inputCode = document.getElementById('room-code').value.trim();
    if (inputCode.length < 4) {
        alert("Enter a valid 4-digit room code.");
        return;
    }
    roomCode = inputCode;
    currentMode = 'cloud_client';
    
    initMqtt();
    startUI();
    animateWave();
}

function initMqtt() {
    // Connect to public EMQX broker over Secure WebSockets
    mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt');
    const topic = `dualbeat/room/${roomCode}`;
    
    mqttClient.on('connect', () => {
        console.log("Connected to Cloud Broker");
        document.getElementById('sync-status').innerText = currentMode === 'cloud_host' ? 'HOSTING CLOUD ROOM' : 'CALIBRATING CLOCK...';
        document.getElementById('sync-status').className = 'sync-badge active';
        
        if (currentMode === 'cloud_host') {
            mqttClient.subscribe(`dualbeat/room/${roomCode}/ping`);
        } else if (currentMode === 'cloud_client') {
            mqttClient.subscribe(topic);
            mqttClient.subscribe(`dualbeat/room/${roomCode}/pong`);
            
            // Perform NTP-style clock calibration
            sendPing();
            pingInterval = setInterval(sendPing, 5000); // recalibrate every 5s
        }
    });
    
    mqttClient.on('message', (t, message) => {
        if (currentMode === 'cloud_host' && t === `dualbeat/room/${roomCode}/ping`) {
            try {
                const p = JSON.parse(message.toString());
                mqttClient.publish(`dualbeat/room/${roomCode}/pong`, JSON.stringify({
                    clientId: p.clientId,
                    clientTime: p.clientTime,
                    hostTime: Date.now()
                }), { qos: 0 });
            } catch(e) {}
        }
        else if (currentMode === 'cloud_client') {
            if (t === topic) {
                try {
                    const data = JSON.parse(message.toString());
                    handleSyncData(data, true);
                } catch(e) {}
            } else if (t === `dualbeat/room/${roomCode}/pong`) {
                try {
                    const p = JSON.parse(message.toString());
                    if (p.clientId === myClientId) {
                        const current = Date.now();
                        const rtt = current - p.clientTime;
                        const estimatedHostTime = p.hostTime + (rtt / 2);
                        clockOffset = estimatedHostTime - current;
                        document.getElementById('sync-status').innerText = "SYNCED (RTT " + rtt + "ms)";
                    }
                } catch(e) {}
            }
        }
    });
}

function sendPing() {
    if (mqttClient && mqttClient.connected) {
        mqttClient.publish(`dualbeat/room/${roomCode}/ping`, JSON.stringify({
            clientId: myClientId,
            clientTime: Date.now()
        }), { qos: 0 });
    }
}

function publishCloudState() {
    if (!mqttClient || !mqttClient.connected) return;
    const payload = JSON.stringify(cloudState);
    mqttClient.publish(`dualbeat/room/${roomCode}`, payload, { qos: 0, retain: true });
}

function loadYouTubeVideo() {
    const url = document.getElementById('yt-url').value.trim();
    if (!url) return;
    
    // Extract video ID
    let vid = url;
    const rx = /^.*(?:(?:youtu\.be\/|v\/|vi\/|u\/\w\/|embed\/|shorts\/)|(?:(?:watch)?\?v(?:i)?=|\&v(?:i)?=))([^#\&\?]*).*/;
    const match = url.match(rx);
    if (match && match[1]) {
        vid = match[1];
    }
    
    cloudState.trackTitle = "YOUTUBE:" + vid;
    cloudState.trackPositionMs = 0;
    cloudState.isPlaying = true;
    publishCloudState();
    
    applyTrackTitle(cloudState.trackTitle);
}

function toggleCloudPlayPause() {
    if (!ytPlayer || typeof ytPlayer.getPlayerState !== 'function') return;
    const state = ytPlayer.getPlayerState();
    if (state === 1) {
        ytPlayer.pauseVideo();
        cloudState.isPlaying = false;
    } else {
        ytPlayer.playVideo();
        cloudState.isPlaying = true;
    }
    publishCloudState();
}

function startUI() {
    isUnlocked = true;
    document.getElementById('connection-panel').style.display = 'none';
    document.getElementById('display-panel').style.display = 'block';
    document.getElementById('cal-panel').style.display = 'block';
    document.getElementById('diagnostic-btn').style.display = 'block';
}

function applyTrackTitle(title) {
    document.getElementById('track-title').innerText = title.replace("YOUTUBE:", "YouTube Video: ");
    
    if (window.currentTrackTitle !== title) {
        window.currentTrackTitle = title;
        
        if (title.startsWith("YOUTUBE:")) {
            const vid = title.split(":")[1];
            document.getElementById('yt-player-container').style.display = 'block';
            document.getElementById('wave-svg').style.display = 'none';
            if (audioElement) {
                audioElement.pause();
            }
            if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
                ytPlayer.loadVideoById(vid);
            }
        } else {
            // Local MP3 fallback
            document.getElementById('yt-player-container').style.display = 'none';
            document.getElementById('wave-svg').style.display = 'block';
            if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
                ytPlayer.pauseVideo();
            }
            
            if (!audioElement) {
                audioElement = new Audio();
                audioElement.crossOrigin = "anonymous";
            }
            audioElement.src = `${leaderBaseUrl}/track_stream?t=` + encodeURIComponent(title);
            audioElement.load();
        }
    }
}

function handleSyncData(data, isCloud) {
    const masterIsPlaying = data.isPlaying;
    let masterPos = data.trackPositionMs / 1000.0;
    const masterTitle = data.trackTitle;
    
    applyTrackTitle(masterTitle);
    
    if (isCloud && data.timestamp) {
        // Precise NTP-calibrated transit latency mapping
        const hostTimeNow = Date.now() + clockOffset;
        const driftMs = hostTimeNow - data.timestamp;
        if (driftMs > -500 && driftMs < 5000) {
            masterPos += (driftMs / 1000.0);
        }
    }

    if (masterIsPlaying) {
        if (currentMode !== 'cloud_client') {
             // For legacy local mode
             document.getElementById('sync-status').innerText = "SYNCED & CALIBRATED";
        }
        document.getElementById('sync-status').className = "sync-badge active";
        
        // Include manual user calibration latency
        const targetPos = masterPos + (compensationMs / 1000.0);
        
        if (masterTitle.startsWith("YOUTUBE:")) {
            if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
                const drift = Math.abs(ytPlayer.getCurrentTime() - targetPos);
                if (ytPlayer.getPlayerState() !== 1) ytPlayer.playVideo();
                // YouTube buffer tolerance: only hard seek if off by more than 200ms
                if (drift > 0.200) ytPlayer.seekTo(targetPos + 0.1, true);
            }
        } else {
            const drift = targetPos - (audioElement.currentTime || 0);
            const absDrift = Math.abs(drift);
            
            if (audioElement && audioElement.paused) {
                audioElement.play().catch(e => console.log("Awaiting gesture"));
            }
            
            if (audioElement) {
                if (absDrift > 0.250) {
                    // Hard seek if way off
                    audioElement.currentTime = targetPos;
                    audioElement.playbackRate = 1.0;
                } else if (absDrift > 0.025) {
                    // Micro-sync playback rate correction (Pitch shifting sync)
                    audioElement.playbackRate = drift > 0 ? 1.04 : 0.96;
                } else {
                    // Perfect sync range
                    audioElement.playbackRate = 1.0;
                }
            }
        }
    } else {
        document.getElementById('sync-status').innerText = "PAUSED BY HOST";
        document.getElementById('sync-status').className = "sync-badge paused";
        
        if (masterTitle.startsWith("YOUTUBE:")) {
            if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') ytPlayer.pauseVideo();
        } else {
            if (audioElement && !audioElement.paused) audioElement.pause();
        }
    }
}

async function startSyncLoop() {
    if (currentMode !== 'local') return; // Handled by MQTT
    
    while (true) {
        try {
            const t0 = Date.now();
            const resp = await fetch(`${leaderBaseUrl}/status`);
            const data = await resp.json();
            const t1 = Date.now();
            
            const rtt = t1 - t0;
            // Adjust position with local network RTT
            data.trackPositionMs += (rtt / 2.0);
            
            handleSyncData(data, false);
            if (audioElement && data.volume !== undefined) audioElement.volume = parseFloat(data.volume);
            
        } catch (error) {
            document.getElementById('sync-status').innerText = "RECONNECTING...";
            document.getElementById('sync-status').className = "sync-badge error";
        }
        await new Promise(r => setTimeout(r, 1200));
    }
}

function updateCalibration(val) {
    compensationMs = parseInt(val);
    document.getElementById('cal-val').innerText = (compensationMs >= 0 ? "+" : "") + compensationMs + " ms";
}

function playDeviceTestTone() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    osc.connect(ctx.destination);
    osc.frequency.value = 440;
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
}

function animateWave() {
    waveAngle += 0.06;
    const activeScale = 1.0;
    let d1 = "M 0,30 "; let d2 = "M 0,30 ";
    for (let x = 0; x <= 400; x += 10) {
        const t = x / 400.0;
        const y1 = 30 + Math.sin(t * Math.PI * 2.5 - waveAngle) * 16 * activeScale;
        const y2 = 30 + Math.sin(t * Math.PI * 4.0 + waveAngle * 1.3) * 8 * activeScale;
        d1 += "L " + x + "," + y1 + " "; d2 += "L " + x + "," + y2 + " ";
    }
    document.getElementById('path1').setAttribute('d', d1);
    document.getElementById('path2').setAttribute('d', d2);
    requestAnimationFrame(animateWave);
}
