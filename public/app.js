// LoRa Chat Frontend

const socket = io();

// State
let state = {
  connected: false,
  selfInfo: null,
  contacts: [],
  messages: [],
  aiEnabled: true,
  currentChat: { type: 'channel', channelIdx: 0 },
};

// DOM Elements
const elements = {
  status: document.getElementById('connection-status'),
  deviceInfo: document.getElementById('device-info'),
  deviceName: document.getElementById('device-name'),
  deviceKey: document.getElementById('device-key'),
  aiToggle: document.getElementById('ai-enabled'),
  channelList: document.getElementById('channel-list'),
  contactList: document.getElementById('contact-list'),
  chatTitle: document.getElementById('chat-title'),
  chatSubtitle: document.getElementById('chat-subtitle'),
  messages: document.getElementById('messages'),
  messageForm: document.getElementById('message-form'),
  messageText: document.getElementById('message-text'),
  sendBtn: document.getElementById('send-btn'),
};

// Socket Events
socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('state', (newState) => {
  console.log('State update:', newState);

  if (newState.connected !== undefined) {
    state.connected = newState.connected;
    updateConnectionStatus();
  }

  if (newState.selfInfo) {
    state.selfInfo = newState.selfInfo;
    updateDeviceInfo();
  }

  if (newState.contacts) {
    state.contacts = newState.contacts;
    updateContactList();
  }

  if (newState.messages) {
    state.messages = newState.messages;
    renderMessages();
  }

  if (newState.aiEnabled !== undefined) {
    state.aiEnabled = newState.aiEnabled;
    elements.aiToggle.checked = state.aiEnabled;
  }
});

socket.on('status', (status) => {
  updateStatus(status);
});

socket.on('message', (msg) => {
  state.messages.push(msg);
  renderMessages();
  scrollToBottom();
});

socket.on('aiStatus', (enabled) => {
  state.aiEnabled = enabled;
  elements.aiToggle.checked = enabled;
});

socket.on('error', (error) => {
  alert(error);
});

// UI Updates
function updateConnectionStatus() {
  elements.status.textContent = state.connected ? 'Connected' : 'Disconnected';
  elements.status.className = `status ${state.connected ? 'connected' : 'disconnected'}`;
  elements.sendBtn.disabled = !state.connected;
}

function updateStatus(status) {
  elements.status.textContent = status;
  if (status.includes('Connecting')) {
    elements.status.className = 'status connecting';
  }
}

function updateDeviceInfo() {
  if (state.selfInfo) {
    elements.deviceInfo.style.display = 'block';
    elements.deviceName.textContent = state.selfInfo.name;
    elements.deviceKey.textContent = state.selfInfo.publicKey.substring(0, 16) + '...';
  } else {
    elements.deviceInfo.style.display = 'none';
  }
}

function updateContactList() {
  elements.contactList.innerHTML = '';

  for (const contact of state.contacts) {
    const li = document.createElement('li');
    li.className = 'chat-item';
    li.dataset.type = 'direct';
    li.dataset.publicKey = contact.publicKey;
    li.innerHTML = `
      <span class="chat-icon">${contact.name.charAt(0).toUpperCase()}</span>
      <span class="chat-name">${escapeHtml(contact.name)}</span>
    `;
    li.addEventListener('click', () => selectChat('direct', contact));
    elements.contactList.appendChild(li);
  }
}

function selectChat(type, data) {
  // Update active state
  document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));

  if (type === 'channel') {
    state.currentChat = { type: 'channel', channelIdx: data.channelIdx || 0 };
    elements.chatTitle.textContent = `# ${data.name || 'Public'}`;
    elements.chatSubtitle.textContent = 'Channel messages';
    document.querySelector(`[data-channel="${data.channelIdx || 0}"]`)?.classList.add('active');
  } else {
    state.currentChat = { type: 'direct', publicKey: data.publicKey, name: data.name };
    elements.chatTitle.textContent = data.name;
    elements.chatSubtitle.textContent = `Direct message`;
    document.querySelector(`[data-public-key="${data.publicKey}"]`)?.classList.add('active');
  }

  renderMessages();
}

function renderMessages() {
  const filtered = state.messages.filter(msg => {
    if (state.currentChat.type === 'channel') {
      return msg.type === 'channel' && msg.channelIdx === state.currentChat.channelIdx;
    } else {
      return msg.type === 'direct' && (
        msg.contact === state.currentChat.name ||
        msg.pubKeyPrefix === state.currentChat.publicKey?.substring(0, 12)
      );
    }
  });

  if (filtered.length === 0) {
    elements.messages.innerHTML = `
      <div class="empty-state">
        <p>No messages yet</p>
        <p class="hint">Messages will appear here when received</p>
      </div>
    `;
    return;
  }

  elements.messages.innerHTML = filtered.map(msg => {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const isOutgoing = msg.outgoing;
    const isAI = msg.isAI;

    return `
      <div class="message ${isOutgoing ? 'outgoing' : 'incoming'} ${isAI ? 'ai' : ''}">
        <div class="message-sender">
          ${escapeHtml(msg.sender)}
          ${isAI ? '<span class="message-ai-badge">AI</span>' : ''}
        </div>
        <div class="message-text">${escapeHtml(msg.text)}</div>
        <div class="message-time">${time}</div>
      </div>
    `;
  }).join('');

  scrollToBottom();
}

function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event Handlers
elements.aiToggle.addEventListener('change', (e) => {
  socket.emit('toggleAI', e.target.checked);
});

elements.messageForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const text = elements.messageText.value.trim();
  if (!text || !state.connected) return;

  socket.emit('sendMessage', {
    type: state.currentChat.type,
    channelIdx: state.currentChat.channelIdx,
    publicKey: state.currentChat.publicKey,
    text: text,
  });

  elements.messageText.value = '';
});

// Channel click handler
document.querySelector('[data-channel="0"]').addEventListener('click', () => {
  selectChat('channel', { channelIdx: 0, name: 'Public' });
});

// Initialize
updateConnectionStatus();
