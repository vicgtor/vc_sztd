'use strict';

// ===== State =====
const state = {
  socket: null,
  localStream: null,
  screenStream: null,
  peers: new Map(),        // peerId -> RTCPeerConnection
  peerInfo: new Map(),     // peerId -> { name, videoOn, audioOn }
  myName: '',
  roomId: '',
  audioOn: true,
  videoOn: true,
  screenSharing: false,
  chatOpen: false,
  unreadChat: 0,
};

// ICE servers (STUN only — for LAN/local testing this is fine)
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// ===== DOM helpers =====
const $ = id => document.getElementById(id);
const lobby      = $('lobby');
const conference = $('conference');
const videoGrid  = $('videoGrid');

// ===== Preview (lobby) =====
let previewMicOn = true;
let previewCamOn = true;
let previewStream = null;

async function startPreview() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('previewOff').innerHTML = `
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <span style="color:#f87171;text-align:center;padding:0 12px">需要 HTTPS 才能访问摄像头<br>请确认地址以 https:// 开头</span>`;
    return;
  }
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('previewVideo').srcObject = previewStream;
    $('previewOff').classList.add('hidden');
  } catch (e) {
    console.warn('Preview not available:', e.name, e.message);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      $('previewOff').innerHTML = `
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
        <span style="color:#f87171;text-align:center;padding:0 12px">摄像头权限被拒绝<br>请点击地址栏左侧允许摄像头和麦克风</span>`;
    }
  }
}

function stopPreview() {
  if (previewStream) {
    previewStream.getTracks().forEach(t => t.stop());
    previewStream = null;
  }
}

$('previewMicBtn').addEventListener('click', () => {
  previewMicOn = !previewMicOn;
  if (previewStream) {
    previewStream.getAudioTracks().forEach(t => t.enabled = previewMicOn);
  }
  $('previewMicBtn').classList.toggle('off', !previewMicOn);
  $('previewMicBtn').querySelector('.icon-mic').classList.toggle('hidden', !previewMicOn);
  $('previewMicBtn').querySelector('.icon-mic-off').classList.toggle('hidden', previewMicOn);
});

$('previewCamBtn').addEventListener('click', () => {
  previewCamOn = !previewCamOn;
  if (previewStream) {
    previewStream.getVideoTracks().forEach(t => t.enabled = previewCamOn);
  }
  $('previewCamBtn').classList.toggle('off', !previewCamOn);
  $('previewCamBtn').querySelector('.icon-cam').classList.toggle('hidden', !previewCamOn);
  $('previewCamBtn').querySelector('.icon-cam-off').classList.toggle('hidden', previewCamOn);
  $('previewOff').classList.toggle('hidden', previewCamOn);
});

// ===== Join =====
$('joinBtn').addEventListener('click', joinMeeting);
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinMeeting(); });
$('roomInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinMeeting(); });

async function joinMeeting() {
  const name = $('nameInput').value.trim();
  if (!name) { $('nameInput').focus(); return; }

  const roomId = $('roomInput').value.trim() || generateId();
  state.myName = name;
  state.roomId = roomId;
  state.audioOn = previewMicOn;
  state.videoOn = previewCamOn;

  // Reuse preview stream as local stream
  if (previewStream) {
    state.localStream = previewStream;
    previewStream = null;
  } else {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      state.localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        .catch(() => new MediaStream());
    }
  }

  applyMediaState();
  showConference();
  connectSocket();
}

function applyMediaState() {
  if (!state.localStream) return;
  state.localStream.getAudioTracks().forEach(t => t.enabled = state.audioOn);
  state.localStream.getVideoTracks().forEach(t => t.enabled = state.videoOn);
}

// ===== Conference UI =====
function showConference() {
  lobby.classList.add('hidden');
  conference.classList.remove('hidden');

  $('roomIdDisplay').textContent = `ID: ${state.roomId}`;

  // Local tile
  addVideoTile('local', state.myName, state.localStream, true);
  updateGrid();

  // Sync toolbar state
  updateMicBtn();
  updateCamBtn();
}

// ===== Video Grid =====
function addVideoTile(id, name, stream, isLocal = false) {
  if (document.getElementById(`tile-${id}`)) return;

  const tile = document.createElement('div');
  tile.className = `video-tile${isLocal ? ' local' : ''}`;
  tile.id = `tile-${id}`;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  if (stream) {
    video.srcObject = stream;
  }

  // Avatar overlay (shown when camera off)
  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.id = `avatar-${id}`;
  avatar.innerHTML = `
    <div class="avatar-circle">${name.charAt(0)}</div>
    <div class="avatar-name">${escapeHtml(name)}</div>
  `;

  // Info bar
  const info = document.createElement('div');
  info.className = 'tile-info';
  info.innerHTML = `
    <div class="tile-name">${escapeHtml(name)}${isLocal ? ' (我)' : ''}</div>
    <div class="tile-icons" id="icons-${id}"></div>
  `;

  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(info);
  videoGrid.appendChild(tile);

  updateTileAvatar(id, stream && stream.getVideoTracks().some(t => t.enabled && t.readyState === 'live'));
}

function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  updateGrid();
}

function updateTileAvatar(id, videoActive) {
  const tile = document.getElementById(`tile-${id}`);
  if (!tile) return;
  const video = tile.querySelector('video');
  const avatar = document.getElementById(`avatar-${id}`);
  if (video) video.style.display = videoActive ? 'block' : 'none';
  if (avatar) avatar.style.display = videoActive ? 'none' : 'flex';
}

function updateTileIcons(id, audioOn) {
  const icons = document.getElementById(`icons-${id}`);
  if (!icons) return;
  icons.innerHTML = audioOn ? '' : `
    <div class="tile-icon muted" title="已静音">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
      </svg>
    </div>
  `;
}

function updateGrid() {
  const count = videoGrid.children.length;
  videoGrid.className = `video-grid count-${Math.min(count, 9)}`;
  $('peerCount').textContent = `${count}人`;
}

// ===== Socket.io =====
function connectSocket() {
  state.socket = io();
  const socket = state.socket;

  socket.emit('join-room', { roomId: state.roomId, userName: state.myName });

  socket.on('room-peers', async (peers) => {
    for (const peer of peers) {
      state.peerInfo.set(peer.peerId, { name: peer.name, videoOn: peer.videoOn, audioOn: peer.audioOn });
      await createOffer(peer.peerId);
    }
  });

  socket.on('peer-joined', ({ peerId, name, videoOn, audioOn }) => {
    state.peerInfo.set(peerId, { name, videoOn, audioOn });
    // Offer will come from the new peer's side (they call us); we wait for offer
  });

  socket.on('offer', async ({ from, offer }) => {
    await handleOffer(from, offer);
  });

  socket.on('answer', async ({ from, answer }) => {
    const pc = state.peers.get(from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    const pc = state.peers.get(from);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  socket.on('peer-media-state', ({ peerId, videoOn, audioOn }) => {
    const info = state.peerInfo.get(peerId);
    if (info) { info.videoOn = videoOn; info.audioOn = audioOn; }
    updateTileIcons(peerId, audioOn);
    // Video track state is reflected in the stream automatically via sender/receiver
    // But if we need to show avatar:
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      const video = tile.querySelector('video');
      const hasVideo = video && video.srcObject &&
        video.srcObject.getVideoTracks().some(t => t.readyState === 'live');
      updateTileAvatar(peerId, videoOn && hasVideo);
    }
  });

  socket.on('peer-left', ({ peerId }) => {
    closePeer(peerId);
    removeVideoTile(peerId);
    state.peerInfo.delete(peerId);
  });

  socket.on('chat-message', (msg) => {
    appendChatMessage(msg);
    if (!state.chatOpen) {
      state.unreadChat++;
      $('chatBadge').textContent = state.unreadChat;
      $('chatBadge').classList.remove('hidden');
    }
  });
}

// ===== WebRTC =====
function createPeerConnection(peerId) {
  if (state.peers.has(peerId)) return state.peers.get(peerId);

  const pc = new RTCPeerConnection(ICE_CONFIG);
  state.peers.set(peerId, pc);

  // Add local tracks
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
  }

  // ICE
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit('ice-candidate', { to: peerId, candidate });
    }
  };

  // Remote stream
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    const info = state.peerInfo.get(peerId);
    const name = info ? info.name : 'Unknown';

    const tile = document.getElementById(`tile-${peerId}`);
    if (!tile) {
      addVideoTile(peerId, name, stream);
    } else {
      const video = tile.querySelector('video');
      if (video) video.srcObject = stream;
    }
    updateGrid();

    // Update avatar visibility each time a track arrives
    const hasVideo = stream.getVideoTracks().some(t => t.readyState === 'live');
    const videoOn = info ? info.videoOn : true;
    updateTileAvatar(peerId, videoOn && hasVideo);

    // Watch for track mute/unmute
    stream.onaddtrack = stream.onremovetrack = () => {
      const videoActive = stream.getVideoTracks().some(t => !t.muted);
      updateTileAvatar(peerId, videoActive);
    };
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      closePeer(peerId);
      removeVideoTile(peerId);
    }
  };

  return pc;
}

async function createOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit('offer', { to: peerId, offer });
}

async function handleOffer(from, offer) {
  const pc = createPeerConnection(from);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.socket.emit('answer', { to: from, answer });
}

function closePeer(peerId) {
  const pc = state.peers.get(peerId);
  if (pc) { pc.close(); state.peers.delete(peerId); }
}

// ===== Toolbar controls =====

// Mic
$('micBtn').addEventListener('click', () => {
  state.audioOn = !state.audioOn;
  state.localStream?.getAudioTracks().forEach(t => t.enabled = state.audioOn);
  updateMicBtn();
  emitMediaState();
  updateTileIcons('local', state.audioOn);
});

function updateMicBtn() {
  const btn = $('micBtn');
  btn.classList.toggle('off', !state.audioOn);
  btn.querySelector('.icon-mic').classList.toggle('hidden', !state.audioOn);
  btn.querySelector('.icon-mic-off').classList.toggle('hidden', state.audioOn);
  btn.querySelector('.tool-label').textContent = state.audioOn ? '静音' : '取消静音';
}

// Camera
$('camBtn').addEventListener('click', () => {
  state.videoOn = !state.videoOn;
  state.localStream?.getVideoTracks().forEach(t => t.enabled = state.videoOn);
  updateCamBtn();
  updateTileAvatar('local', state.videoOn && hasLocalVideo());
  emitMediaState();
});

function hasLocalVideo() {
  return state.localStream?.getVideoTracks().some(t => t.readyState === 'live') ?? false;
}

function updateCamBtn() {
  const btn = $('camBtn');
  btn.classList.toggle('off', !state.videoOn);
  btn.querySelector('.icon-cam').classList.toggle('hidden', !state.videoOn);
  btn.querySelector('.icon-cam-off').classList.toggle('hidden', state.videoOn);
  btn.querySelector('.tool-label').textContent = state.videoOn ? '关闭视频' : '开启视频';
}

// Screen share
$('screenBtn').addEventListener('click', async () => {
  if (state.screenSharing) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
});

async function startScreenShare() {
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; }

  const screenTrack = state.screenStream.getVideoTracks()[0];

  // Replace video track in all peer connections
  for (const [, pc] of state.peers) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(screenTrack);
  }

  // Show in local tile
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) {
    const mixed = new MediaStream([
      screenTrack,
      ...(state.localStream?.getAudioTracks() ?? [])
    ]);
    localVideo.srcObject = mixed;
  }

  state.screenSharing = true;
  $('screenBtn').classList.add('screen-active');
  $('screenBtn').querySelector('.tool-label').textContent = '停止共享';
  updateTileAvatar('local', true);

  screenTrack.onended = () => stopScreenShare();
}

async function stopScreenShare() {
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.screenStream = null;

  const camTrack = state.localStream?.getVideoTracks()[0] ?? null;

  for (const [, pc] of state.peers) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(camTrack);
  }

  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) localVideo.srcObject = state.localStream;

  state.screenSharing = false;
  $('screenBtn').classList.remove('screen-active');
  $('screenBtn').querySelector('.tool-label').textContent = '共享屏幕';
  updateTileAvatar('local', state.videoOn && hasLocalVideo());
}

// Leave
$('leaveBtn').addEventListener('click', leaveMeeting);

function leaveMeeting() {
  stopScreenShare();
  state.localStream?.getTracks().forEach(t => t.stop());
  state.peers.forEach((pc) => pc.close());
  state.peers.clear();
  state.socket?.disconnect();

  // Reset UI
  conference.classList.add('hidden');
  videoGrid.innerHTML = '';
  $('chatMessages').innerHTML = '';
  lobby.classList.remove('hidden');

  // Restart preview
  $('nameInput').value = '';
  $('roomInput').value = '';
  previewMicOn = true;
  previewCamOn = true;
  $('previewMicBtn').classList.remove('off');
  $('previewCamBtn').classList.remove('off');
  $('previewMicBtn').querySelector('.icon-mic').classList.remove('hidden');
  $('previewMicBtn').querySelector('.icon-mic-off').classList.add('hidden');
  $('previewCamBtn').querySelector('.icon-cam').classList.remove('hidden');
  $('previewCamBtn').querySelector('.icon-cam-off').classList.add('hidden');
  $('previewOff').classList.add('hidden');
  startPreview();
}

// Copy room ID
$('copyRoomBtn').addEventListener('click', () => {
  const url = `${location.origin}?room=${state.roomId}`;
  navigator.clipboard.writeText(url).then(() => {
    const btn = $('copyRoomBtn');
    btn.style.color = '#22c55e';
    setTimeout(() => btn.style.color = '', 1500);
  });
});

// Auto-fill room from URL param
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('roomInput').value = urlRoom;

// ===== Chat =====
$('chatToggleBtn').addEventListener('click', () => {
  state.chatOpen = !state.chatOpen;
  $('chatPanel').classList.toggle('hidden', !state.chatOpen);
  if (state.chatOpen) {
    state.unreadChat = 0;
    $('chatBadge').classList.add('hidden');
    $('chatInput').focus();
  }
});

$('chatCloseBtn').addEventListener('click', () => {
  state.chatOpen = false;
  $('chatPanel').classList.add('hidden');
});

$('sendBtn').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function sendChat() {
  const msg = $('chatInput').value.trim();
  if (!msg || !state.socket) return;
  state.socket.emit('chat-message', { message: msg });
  $('chatInput').value = '';
}

function appendChatMessage({ from, name, message, time }) {
  const isSelf = from === state.socket?.id;
  const div = document.createElement('div');
  div.className = `chat-msg${isSelf ? ' self' : ''}`;
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-name${isSelf ? ' self' : ''}">${escapeHtml(name)}</span>
      <span class="msg-time">${time}</span>
    </div>
    <div class="msg-text">${escapeHtml(message)}</div>
  `;
  const msgs = $('chatMessages');
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ===== Emit media state =====
function emitMediaState() {
  state.socket?.emit('media-state', { videoOn: state.videoOn, audioOn: state.audioOn });
}

// ===== Utils =====
function generateId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ===== Init =====
startPreview();
