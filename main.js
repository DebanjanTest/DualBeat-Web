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
let isSyncing = false;
let syncInterval = null;
let isWaitingForGlobalStart = false;

let cloudState = {
    isPlaying: false,
    trackTitle: "",
    trackPositionMs: 0,
    timestamp: 0,
    globalStartTime: 0
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

let isYoutubeApiReady = false;

window.onYouTubeIframeAPIReady = function() {
    console.log("YouTube API Loaded");
    isYoutubeApiReady = true;
};

function checkYouTubeApi() {
    if (window.YT && window.YT.Player) {
        isYoutubeApiReady = true;
    }
    return isYoutubeApiReady;
}

function scheduleGlobalStart() {
    const hostTimeNow = Date.now() + clockOffset;
    const timeUntilStart = (window.currentGlobalStartTime || 0) - hostTimeNow;
    
    if (timeUntilStart > 0) {
        isWaitingForGlobalStart = true;
        document.getElementById('sync-status').innerText = "GLOBAL START IN " + Math.round(timeUntilStart/1000) + "s";
        document.getElementById('sync-status').className = "sync-badge error";
        
        const startInterval = setInterval(() => {
            const currentHostTime = Date.now() + clockOffset;
            if (currentHostTime >= window.currentGlobalStartTime) {
                clearInterval(startInterval);
                isWaitingForGlobalStart = false;
                if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
                    ytPlayer.playVideo();
                }
                document.getElementById('sync-status').innerText = "SYNCED";
                document.getElementById('sync-status').className = "sync-badge active";
            } else {
                document.getElementById('sync-status').innerText = "GLOBAL START IN " + Math.round((window.currentGlobalStartTime - currentHostTime)/1000) + "s";
            }
        }, 10);
    } else {
        isWaitingForGlobalStart = false;
        if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
            ytPlayer.playVideo();
        }
    }
}

function initOrLoadYouTube(vid) {
    if (!checkYouTubeApi()) {
        setTimeout(() => initOrLoadYouTube(vid), 500);
        return;
    }
    
    if (!ytPlayer) {
        ytPlayer = new YT.Player('yt-player', {
            height: '100%',
            width: '100%',
            videoId: vid,
            playerVars: { 'autoplay': 0, 'controls': 1, 'disablekb': 0, 'fs': 0, 'modestbranding': 1, 'rel': 0 },
            events: {
                'onReady': function(event) {
                    console.log("YouTube Player Ready");
                    if (window.currentGlobalStartTime) {
                        event.target.cueVideoById(vid);
                        scheduleGlobalStart();
                    } else {
                        event.target.playVideo();
                    }
                }
            }
        });
    } else if (typeof ytPlayer.loadVideoById === 'function') {
        if (window.currentGlobalStartTime) {
            ytPlayer.cueVideoById(vid);
            scheduleGlobalStart();
        } else {
            ytPlayer.loadVideoById(vid);
        }
    }
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
        if (currentMode === 'cloud_host' && ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
            const state = ytPlayer.getPlayerState();
            // If the Host is buffering (3), keep broadcasting "isPlaying" to prevent the clients from stutter-pausing.
            cloudState.isPlaying = (state === 1 || state === 3);
            cloudState.trackPositionMs = Math.floor(ytPlayer.getCurrentTime() * 1000);
            
            // Dynamic video ID extraction to perfectly support Playlists / Mixes auto-advancing
            let currentVid = null;
            let currentName = "YouTube Video";
            if (typeof ytPlayer.getVideoData === 'function') {
                const data = ytPlayer.getVideoData();
                if (data && data.video_id) {
                    currentVid = data.video_id;
                    if (data.title) currentName = data.title;
                }
            }
            if (!currentVid && typeof ytPlayer.getVideoUrl === 'function') {
                const match = ytPlayer.getVideoUrl().match(/[?&]v=([^&]+)/);
                if (match && match[1]) currentVid = match[1];
            }
            
            if (currentVid) {
                const newTitle = "YOUTUBE:" + currentVid + "|" + currentName;
                cloudState.trackTitle = newTitle;
                window.currentTrackTitle = newTitle; // Lock host local state to prevent reloading
            }
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
                        const newOffset = estimatedHostTime - current;
                        
                        // Smooth the clock offset, but immediately accept huge timezone jumps
                        if (clockOffset === 0 || Math.abs(newOffset - clockOffset) > 2000) {
                            clockOffset = newOffset;
                        } else {
                            clockOffset = (clockOffset * 0.8) + (newOffset * 0.2);
                        }
                        
                        document.getElementById('sync-status').innerText = "SYNCED (RTT " + Math.round(rtt) + "ms)";
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
    // Disable retain to prevent late-joining clients from receiving stale, frozen timestamps that cause ghost-loops
    mqttClient.publish(`dualbeat/room/${roomCode}`, payload, { qos: 0, retain: false });
}

function loadYouTubeVideo() {
    const inputEl = document.getElementById('yt-url');
    const url = inputEl.value.trim();
    if (!url) return;
    
    // Clear input visually per user request
    inputEl.value = '';
    
    // Extract video ID and playlist ID
    let vid = null;
    let listId = null;
    
    // Extract playlist ID
    const listMatch = url.match(/[?&]list=([^&]+)/);
    if (listMatch) listId = listMatch[1];
    
    // Extract video ID (robust regex for standard, short, and embed links)
    const rx = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
    const vMatch = url.match(rx);
    if (vMatch) {
        vid = vMatch[1];
    }
    
    // Fallback if it's just a raw 11-character ID
    if (!vid && !listId && url.length === 11) {
        vid = url;
    }
    
    if (!vid && !listId) {
        alert("Could not extract a valid YouTube Video ID or Playlist from the link.");
        return;
    }
    
    if (listId) {
        // It's a Mix / Playlist
        document.getElementById('yt-player-container').style.display = 'block';
        document.getElementById('wave-svg').style.display = 'none';
        if (audioElement) audioElement.pause();
        
        const loadPlaylistFunc = () => {
            if (!isYoutubeApiReady) {
                setTimeout(loadPlaylistFunc, 500);
                return;
            }
            if (!ytPlayer) {
                ytPlayer = new YT.Player('yt-player', {
                    height: '100%', width: '100%',
                    playerVars: { 'autoplay': 1, 'controls': 1, 'disablekb': 0, 'fs': 0, 'modestbranding': 1, 'rel': 0, 'listType': 'playlist', 'list': listId },
                    events: { 'onReady': e => e.target.playVideo() }
                });
            } else {
                ytPlayer.loadPlaylist({list: listId, listType: 'playlist'});
            }
        };
        loadPlaylistFunc();
        
        window.currentTrackTitle = "HOST_PLAYLIST_LOADING";
        if (currentMode === 'cloud_host') {
            cloudState.trackTitle = "YOUTUBE:" + window.youtubeMixQueue[0];
            cloudState.globalStartTime = Date.now() + 2000;
            window.currentGlobalStartTime = cloudState.globalStartTime;
            publishCloudState();
        }
    } else if (vid) {
        cloudState.trackTitle = "YOUTUBE:" + vid;
        cloudState.globalStartTime = Date.now() + 2000;
        window.currentGlobalStartTime = cloudState.globalStartTime;
        applyTrackTitle(cloudState.trackTitle);
    }
    
    // Do not falsely claim we are playing before the player actually starts!
    cloudState.trackPositionMs = 0;
    publishCloudState();
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
    window.currentTrackTitle = title;
    
    isSyncing = false;
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    
    if (title.startsWith("YOUTUBE:")) {
        const payload = title.substring(8);
        const parts = payload.split("|");
        const vid = parts[0];
        const niceName = parts.length > 1 ? parts.slice(1).join("|") : vid;
        
        document.getElementById('track-title').innerText = "Playing: " + niceName;
        
        document.getElementById('yt-player-container').style.display = 'block';
        document.getElementById('wave-svg').style.display = 'none';
        if (audioElement) {
            audioElement.pause();
        }
        initOrLoadYouTube(vid);
    } else {
        document.getElementById('track-title').innerText = title;
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
    
    if (data.globalStartTime) {
        window.currentGlobalStartTime = data.globalStartTime;
    }

    if (masterTitle !== window.currentTrackTitle) {
        applyTrackTitle(masterTitle);
    }

    if (isWaitingForGlobalStart) return;
    
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
                const state = ytPlayer.getPlayerState();
                const clientTime = ytPlayer.getCurrentTime();
                const driftMs = clientTime - targetPos; // Positive = Client is AHEAD
                const absDrift = Math.abs(driftMs);
                
                if (isSyncing) return; // Wait for the rendezvous trap to spring
                
                // Only command play if we aren't already playing or buffering
                if (state !== 1 && state !== 3) {
                    ytPlayer.playVideo();
                }
                
                // Clock-Synced Rendezvous Protocol (Absolute Zero Lag)
                if (state === 1) {
                    const isMassiveJump = absDrift > 5.0; // Host skipped timeline
                    const isCooldownActive = Date.now() - (window.lastSeekTime || 0) < 10000;
                    
                    // Trigger sync if heavily drifted (0.8s), ignoring micro-stutters.
                    // If cooldown is active to prevent stutter loops, ONLY sync if it's a massive jump!
                    if (absDrift > 0.8 && (!isCooldownActive || isMassiveJump)) {
                        isSyncing = true;
                        const hostTimeNow = Date.now() + clockOffset;
                        let rendezvousPos, rendezvousTime;
                        
                        if (driftMs > 0.8 && driftMs < 5.0) {
                            // Client is AHEAD. Freeze exactly here and wait for Host to reach this frame.
                            rendezvousPos = clientTime;
                            rendezvousTime = hostTimeNow + (driftMs * 1000);
                            ytPlayer.pauseVideo();
                        } else {
                            // Client is BEHIND or wildly out of sync.
                            // Jump 3.5 seconds into the Host's future to give the browser time to buffer the leap.
                            const jumpAheadSec = 3.5;
                            rendezvousPos = targetPos + jumpAheadSec;
                            rendezvousTime = hostTimeNow + (jumpAheadSec * 1000);
                            
                            ytPlayer.seekTo(rendezvousPos, true);
                            ytPlayer.pauseVideo();
                        }
                        
                        document.getElementById('sync-status').innerText = "RENDEZVOUS WAITING...";
                        document.getElementById('sync-status').className = "sync-badge error";
                        
                        syncInterval = setInterval(() => {
                            if (!isSyncing) {
                                clearInterval(syncInterval);
                                return;
                            }
                            const currentHostTime = Date.now() + clockOffset;
                            if (currentHostTime >= rendezvousTime) {
                                clearInterval(syncInterval);
                                ytPlayer.playVideo();
                                isSyncing = false;
                                window.lastSeekTime = Date.now(); // Start 10s anti-stutter cooldown
                                document.getElementById('sync-status').innerText = "SYNCED";
                                document.getElementById('sync-status').className = "sync-badge active";
                            }
                        }, 20); // 20ms precision polling
                    }
                }
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
        
        isSyncing = false;
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
        
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
        if (currentMode !== 'local') break; // Kill zombie loop if mode switched
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
