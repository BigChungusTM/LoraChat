import { NodeRuntime, setRuntime, Screen, Box, Text, Button, List, Log, Textbox } from '@unblessed/node';
import { NodeJSSerialConnection, Constants, BufferUtils } from '@liamcottle/meshcore.js';
import NodeJSBleConnection from './ble-connection.js';
import config from './config.js';
import fs from 'fs';

// Initialize unblessed runtime
setRuntime(new NodeRuntime());

// Suppress all console output to prevent UI corruption
const logs = [];
console.log = (...args) => logs.push(['log', ...args]);
console.error = (...args) => logs.push(['error', ...args]);

// Debug file logger
const debugLog = (msg) => {
  fs.appendFileSync('C:/lorachat/debug.log', `${new Date().toISOString()} - ${msg}\n`);
};
// Clear log on start
fs.writeFileSync('C:/lorachat/debug.log', '--- TUI Started ---\n');

// Catch any uncaught exceptions
process.on('uncaughtException', (err) => {
  debugLog(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  debugLog(`UNHANDLED REJECTION: ${reason}`);
});

// Override process.exit to log before exiting
const originalExit = process.exit;
process.exit = (code) => {
  debugLog(`process.exit(${code}) called - stack: ${new Error().stack}`);
  originalExit(code);
};

// Helper to strip blessed-style tags from text
function stripTags(str) {
  return str.replace(/\{[^}]+\}/g, '');
}

// MeshCore contact types
const AdvType = {
  None: 0,
  Chat: 1,      // Can send direct messages
  Repeater: 2,  // Relay only, cannot message
  Room: 3,      // Room server
};

// Message cache file path
const CACHE_FILE = 'C:/lorachat/message-cache.json';

// Load cached messages from file
function loadMessageCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      debugLog(`Loaded ${data.messages?.length || 0} cached messages`);
      return data.messages || [];
    }
  } catch (err) {
    debugLog(`Failed to load cache: ${err.message}`);
  }
  return [];
}

// Save messages to cache file
function saveMessageCache() {
  try {
    const data = {
      lastUpdated: new Date().toISOString(),
      messages: state.messages,
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
    debugLog(`Saved ${state.messages.length} messages to cache`);
  } catch (err) {
    debugLog(`Failed to save cache: ${err.message}`);
  }
}

// ============================================
// State
// ============================================
const state = {
  connection: null,
  connected: false,
  selfInfo: null,
  contacts: [],
  channels: [],  // Will be populated from device
  messages: loadMessageCache(),  // Load cached messages on startup
  pendingMessages: new Map(),
  aiEnabled: true,
  selectedChat: { type: 'channel', idx: 0, name: 'Public' },
  focusedElement: 'sidebar',
};

// ============================================
// Create Screen
// ============================================
process.stdout.write('\x1B[2J\x1B[0f'); // Clear screen

const screen = new Screen({
  smartCSR: true,
  title: 'LoRa Chat',
  fullUnicode: true,
  mouse: true,
});

// Force SGR mouse mode on Windows (unblessed bug - enableMouse() does nothing on Windows)
screen.program.setMouse({
  sgrMouse: true,
  allMotion: true,
  cellMotion: true,
}, true);

// Bind mouse input handler (parses incoming mouse escape sequences)
screen.program.bindMouse();

// Enable mouse event routing to widgets
screen.enableMouse();

// ============================================
// Header Bar
// ============================================
const headerBar = new Box({
  parent: screen,
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  style: { bg: 'blue' },
});

const titleLabel = new Text({
  parent: headerBar,
  top: 1,
  left: 2,
  content: '{bold}LoRa Chat{/}',
  tags: true,
  mouse: false,
  style: { bg: 'blue', fg: 'white' },
});

const statusLabel = new Text({
  parent: headerBar,
  top: 1,
  left: 15,
  tags: true,
  mouse: false,
  style: { bg: 'blue' },
});

// Help text
const helpLabel = new Text({
  parent: headerBar,
  top: 1,
  right: 35,
  content: '{gray-fg}[1]Chats [2]AI [3]Send [Q]uit{/}',
  tags: true,
  mouse: false,
  style: { bg: 'blue' },
});

// AI Toggle Button (mouse only - keyboard shortcut is [2])
const aiButton = new Button({
  parent: headerBar,
  top: 0,
  right: 12,
  width: 12,
  height: 3,
  content: ' AI: ON ',
  align: 'center',
  valign: 'middle',
  tags: true,
  mouse: true,
  keys: false,
  style: {
    bg: 'green',
    fg: 'white',
    hover: { bg: 'cyan' },
    focus: { bg: 'cyan' },
  },
});

// Quit Button (mouse only - keyboard shortcut is [Q])
const quitButton = new Button({
  parent: headerBar,
  top: 0,
  right: 0,
  width: 10,
  height: 3,
  content: ' Quit ',
  align: 'center',
  valign: 'middle',
  tags: true,
  mouse: true,
  keys: false,
  style: {
    bg: 'red',
    fg: 'white',
    hover: { bg: 'magenta' },
    focus: { bg: 'magenta' },
  },
});

function updateAIButton() {
  if (state.aiEnabled) {
    aiButton.setContent('{center} AI: ON {/center}');
    aiButton.style.bg = 'green';
  } else {
    aiButton.setContent('{center} AI: OFF {/center}');
    aiButton.style.bg = 'red';
  }
  screen.render();
}

function toggleAI() {
  state.aiEnabled = !state.aiEnabled;
  updateAIButton();
  setStatus(state.aiEnabled ? 'AI auto-reply enabled' : 'AI auto-reply disabled');
}

function updateStatus(text) {
  const connStatus = state.connected ? '{green-fg}●{/}' : '{red-fg}●{/}';
  const device = state.selfInfo?.name || 'No device';
  statusLabel.setContent(`${connStatus} {white-fg}${device}{/} | ${text}`);
  screen.render();
}

// ============================================
// Sidebar
// ============================================
const sidebar = new List({
  parent: screen,
  top: 3,
  left: 0,
  width: '25%',
  height: '100%-3',
  border: { type: 'line' },
  label: ' {bold}Chats [1]{/} ',
  tags: true,
  keys: true,
  mouse: true,
  style: {
    border: { fg: 'cyan' },
    selected: { bg: 'blue', fg: 'white', bold: true },
    item: { fg: 'white' },
    focus: { border: { fg: 'yellow' } },
  },
  scrollbar: { ch: '│', style: { fg: 'cyan' } },
});

function updateSidebar() {
  const items = [];

  // Filter out undefined/empty channels
  const validChannels = state.channels.filter(ch =>
    ch.name && !ch.name.includes('undefined') && ch.name.trim() !== ''
  );

  // Channels section
  items.push('{cyan-fg}── Channels ──{/}');
  if (validChannels.length === 0) {
    items.push('  {white-fg}No channels{/}');
  } else {
    for (const ch of validChannels) {
      const sel = (state.selectedChat.type === 'channel' && state.selectedChat.idx === ch.idx) ? '► ' : '  ';
      items.push(`${sel}{green-fg}#{/} {white-fg}${ch.name}{/}`);
    }
  }

  // Separate contacts by type
  const clients = state.contacts.filter(c => c.type === AdvType.Chat);
  const repeaters = state.contacts.filter(c => c.type === AdvType.Repeater);
  const rooms = state.contacts.filter(c => c.type === AdvType.Room);

  // Contacts section (can message)
  items.push('');
  items.push('{cyan-fg}── Contacts ──{/}');
  if (clients.length === 0) {
    items.push('  {white-fg}No contacts yet{/}');
  } else {
    for (const contact of clients) {
      const sel = (state.selectedChat.type === 'direct' && state.selectedChat.name === contact.name) ? '► ' : '  ';
      items.push(`${sel}{yellow-fg}@{/} {white-fg}${contact.name}{/}`);
    }
  }

  // Rooms section
  items.push('');
  items.push('{cyan-fg}── Rooms ──{/}');
  if (rooms.length === 0) {
    items.push('  {white-fg}No rooms{/}');
  } else {
    for (const room of rooms) {
      const sel = (state.selectedChat.type === 'direct' && state.selectedChat.name === room.name) ? '► ' : '  ';
      items.push(`${sel}{magenta-fg}⌂{/} {white-fg}${room.name}{/}`);
    }
  }

  // Repeaters section (cannot message directly)
  items.push('');
  items.push('{cyan-fg}── Repeaters ──{/}');
  if (repeaters.length === 0) {
    items.push('  {white-fg}No repeaters{/}');
  } else {
    for (const repeater of repeaters) {
      items.push(`  {blue-fg}◇{/} {white-fg}${repeater.name}{/}`);
    }
  }

  sidebar.setItems(items);
  screen.render();
}

sidebar.on('select', (item, index) => {
  const text = stripTags(item.content).trim();

  // Ignore headers, empty lines, and "No X" messages
  if (text.startsWith('──') || text === '' || text.startsWith('No ')) return;

  // Ignore repeaters (shown with ◇)
  if (text.includes('◇')) {
    setStatus('{yellow-fg}Repeaters relay messages but cannot receive direct messages{/}');
    return;
  }

  if (text.includes('#')) {
    const name = text.replace(/[►#]/g, '').trim();
    const ch = state.channels.find(c => c.name === name);
    if (ch) selectChat('channel', ch.idx, ch.name);
  } else if (text.includes('@') || text.includes('⌂')) {
    const name = text.replace(/[►@⌂]/g, '').trim();
    selectChat('direct', null, name);
  }
});

// Right-click handler for sidebar (context menu)
sidebar.on('mouse', (data) => {
  if (data.action === 'mousedown' && data.button === 'right') {
    // Get the item at the clicked position
    const y = data.y - sidebar.atop - sidebar.itop - 1;  // Adjust for borders
    const items = sidebar.items || [];
    if (y >= 0 && y < items.length) {
      const item = items[y];
      if (item) {
        const text = stripTags(item.content).trim();
        debugLog(`Right-click on: "${text}" at y=${y}`);

        // Check if it's a contact
        if (text.includes('@')) {
          const name = text.replace(/[►@]/g, '').trim();
          const contact = state.contacts.find(c => c.name === name);
          if (contact) {
            setStatus(`{cyan-fg}Right-clicked: ${name} | Options: [D]elete, [P]ing, [I]nfo{/}`);
            // Store for potential action
            state.rightClickedContact = contact;
          }
        } else if (text.includes('◇')) {
          const name = text.replace(/[◇]/g, '').trim();
          setStatus(`{cyan-fg}Repeater: ${name} | [P]ing to check status{/}`);
        }
      }
    }
  }
});

function selectChat(type, idx, name) {
  state.selectedChat = { type, idx, name };
  updateSidebar();
  updateChatHeader();
  renderMessages();
  // Clear any previous status message
  setStatus(`{green-fg}Viewing ${type === 'channel' ? '#' : '@'}${name}{/}`);
}

// ============================================
// Chat Area
// ============================================
const chatArea = new Box({
  parent: screen,
  top: 3,
  left: '25%',
  width: '75%',
  height: '100%-7',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' } },
});

const chatHeader = new Text({
  parent: chatArea,
  top: 0,
  left: 1,
  tags: true,
  mouse: false,
});

const messageList = new Log({
  parent: chatArea,
  top: 1,
  left: 0,
  right: 0,
  bottom: 0,
  tags: true,
  mouse: true,
  keys: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: '│', style: { fg: 'cyan' } },
});

function updateChatHeader() {
  const prefix = state.selectedChat.type === 'channel' ? '#' : '@';
  chatHeader.setContent(`{bold}${prefix} ${state.selectedChat.name}{/}`);
  screen.render();
}

function addMessage(msg) {
  // Check for duplicate (same sender, text, and within 1 second)
  const isDuplicate = state.messages.some(m =>
    m.sender === msg.sender &&
    m.text === msg.text &&
    Math.abs(m.timestamp - msg.timestamp) < 1000
  );

  if (!isDuplicate) {
    state.messages.push(msg);
    saveMessageCache();  // Persist to disk
  }
  renderMessages();
}

function renderMessages() {
  messageList.setContent('');

  const filtered = state.messages.filter(m => {
    if (state.selectedChat.type === 'channel') {
      return m.type === 'channel' && m.channelIdx === state.selectedChat.idx;
    }
    return m.type === 'direct' && m.contactName === state.selectedChat.name;
  });

  if (filtered.length === 0) {
    messageList.log('{gray-fg}No messages yet{/}');
    return;
  }

  for (const msg of filtered) {
    const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const sender = msg.outgoing ? '{green-fg}You{/}' : `{cyan-fg}${msg.sender}{/}`;

    let statusIcon = '';
    if (msg.outgoing) {
      switch (msg.status) {
        case 'sending': statusIcon = ' {yellow-fg}◌{/}'; break;
        case 'sent': statusIcon = ' {blue-fg}✓{/}'; break;
        case 'delivered': statusIcon = ' {green-fg}✓✓{/}'; break;
        case 'failed': statusIcon = ' {red-fg}✗{/}'; break;
      }
    }

    const aiTag = msg.isAI ? ' {magenta-fg}[AI]{/}' : '';
    messageList.log(`{gray-fg}${time}{/} ${sender}${aiTag}: ${msg.text}${statusIcon}`);
  }

  screen.render();
}

function updateMessageStatus(msgId, status) {
  const msg = state.messages.find(m => m.id === msgId);
  if (msg) {
    msg.status = status;
    saveMessageCache();  // Persist status update
    renderMessages();
  }
}

// ============================================
// Input Area
// ============================================
const inputArea = new Box({
  parent: screen,
  bottom: 0,
  left: '25%',
  width: '75%',
  height: 4,
  border: { type: 'line' },
  label: ' {bold}Message [3]{/} ',
  tags: true,
  style: { border: { fg: 'green' } },
});

const inputBox = new Textbox({
  parent: inputArea,
  top: 0,
  left: 0,
  right: 10,
  height: 1,
  keys: false,  // We handle keys manually
  mouse: true,
  inputOnFocus: false,
  style: {
    fg: 'white',
    focus: { fg: 'yellow' },
  },
});

// Simple focus function - no readInput callback needed
function focusInputBox() {
  inputBox.focus();
  screen.render();
}

// Click on inputBox to focus
inputBox.on('click', () => {
  debugLog('inputBox CLICKED');
  focusInputBox();
});

// Handle keypress when inputBox is focused
inputBox.on('keypress', (ch, key) => {
  if (!key) return;

  debugLog(`inputBox keypress: ch="${ch}" name="${key.name}"`);

  if (key.name === 'enter' || key.name === 'return') {
    // Submit message on Enter
    const text = inputBox.getValue();
    debugLog(`Enter pressed, value="${text}"`);
    if (text && text.trim()) {
      sendMessage(text.trim());
    }
    inputBox.clearValue();
    screen.render();
  } else if (key.name === 'escape') {
    // Escape to cancel and go back to sidebar
    inputBox.clearValue();
    sidebar.focus();
    screen.render();
  } else if (key.name === 'backspace') {
    // Handle backspace
    const val = inputBox.getValue();
    if (val.length > 0) {
      inputBox.setValue(val.slice(0, -1));
      screen.render();
    }
  } else if (ch && !key.ctrl && !key.meta) {
    // Regular character - append to value
    const val = inputBox.getValue() || '';
    inputBox.setValue(val + ch);
    screen.render();
  }
});

const sendButton = new Button({
  parent: inputArea,
  top: 0,
  right: 1,
  width: 8,
  height: 1,
  content: ' Send ',
  mouse: true,
  keys: false,  // Mouse only - Enter in textbox triggers submit
  style: {
    bg: 'green',
    fg: 'white',
    hover: { bg: 'cyan' },
    focus: { bg: 'cyan' },
  },
});

function focusInput() {
  focusInputBox();
}

// ============================================
// Status Bar
// ============================================
const statusBar = new Text({
  parent: screen,
  bottom: 4,
  left: '25%',
  width: '75%-2',
  height: 1,
  tags: true,
  mouse: false,
  content: '',
  style: { fg: 'gray' },
});

function setStatus(msg) {
  statusBar.setContent(` ${msg}`);
  screen.render();
}

// Log function for BLE connection
function logTUI(msg) {
  setStatus(msg);
}

// ============================================
// Keyboard Shortcuts (since mouse can be unreliable)
// ============================================
screen.key(['1'], () => { sidebar.focus(); screen.render(); });
screen.key(['2'], () => toggleAI());
screen.key(['3'], () => focusInput());
screen.key(['C-c'], () => {
  debugLog('EXITING via Ctrl+C');
  process.exit(0);
});
screen.key(['escape'], () => { sidebar.focus(); screen.render(); });

// Debug: log all keypresses to see what's happening
screen.on('keypress', (ch, key) => {
  debugLog(`KEYPRESS: ch="${ch}" key.name="${key?.name}" key.full="${key?.full}" focused="${screen.focused?.type}"`);
});

// Debug: log mouse events
screen.on('mouse', (data) => {
  if (data.action === 'mousedown' || data.action === 'mouseup') {
    debugLog(`MOUSE: ${data.action} button=${data.button} at (${data.x},${data.y})`);
  }
});

// Q to quit - but not when typing in textbox
screen.key(['q', 'Q'], () => {
  debugLog(`Q pressed - focused: ${screen.focused?.type}`);
  // Don't quit if we're in input mode
  if (screen.focused === inputBox) {
    debugLog('Q ignored - inputBox focused');
    return;
  }
  debugLog('EXITING via Q key');
  process.exit(0);
});

// Button press events (use 'press' not 'click' for buttons)
aiButton.on('press', () => {
  debugLog('AI button pressed');
  toggleAI();
});
quitButton.on('press', () => {
  debugLog('EXITING via quit button press');
  process.exit(0);
});
sendButton.on('press', () => {
  const text = inputBox.getValue();
  if (text && text.trim()) {
    sendMessage(text.trim());
    inputBox.clearValue();
  }
});

// ============================================
// Message Sending
// ============================================
async function sendMessage(text) {
  if (!state.connected) {
    setStatus('{red-fg}Not connected!{/}');
    return;
  }

  const msgId = Date.now().toString();
  const msg = {
    id: msgId,
    type: state.selectedChat.type,
    channelIdx: state.selectedChat.type === 'channel' ? state.selectedChat.idx : undefined,
    contactName: state.selectedChat.type === 'direct' ? state.selectedChat.name : undefined,
    text,
    sender: state.selfInfo?.name || 'Me',
    outgoing: true,
    status: 'sending',
    timestamp: Date.now(),
  };

  addMessage(msg);
  setStatus('Sending...');

  try {
    if (state.selectedChat.type === 'channel') {
      await state.connection.sendChannelTextMessage(state.selectedChat.idx, text);
      updateMessageStatus(msgId, 'sent');
      setStatus('{green-fg}Sent to channel{/}');
    } else {
      const contact = state.contacts.find(c => c.name === state.selectedChat.name);
      if (contact) {
        const result = await state.connection.sendTextMessage(contact.publicKey, text);

        state.pendingMessages.set(result.expectedAckCrc, {
          msgId,
          timeout: setTimeout(() => {
            if (state.pendingMessages.has(result.expectedAckCrc)) {
              state.pendingMessages.delete(result.expectedAckCrc);
            }
          }, result.estTimeout + 5000),
        });

        updateMessageStatus(msgId, 'sent');
        setStatus('{blue-fg}Sent, awaiting confirmation...{/}');
      } else {
        updateMessageStatus(msgId, 'failed');
        setStatus('{red-fg}Contact not found{/}');
      }
    }
  } catch (err) {
    updateMessageStatus(msgId, 'failed');
    setStatus(`{red-fg}Failed: ${err.message}{/}`);
  }
}

// ============================================
// MeshCore Connection
// ============================================
let retryAttempt = 0;
let retryTimer = null;
let retryCountdown = null;

function scheduleRetry() {
  // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
  const baseDelay = 2000;
  const delay = Math.min(baseDelay * Math.pow(2, retryAttempt), 30000);
  retryAttempt++;

  let remaining = Math.ceil(delay / 1000);
  updateStatus(`{red-fg}Retry in ${remaining}s{/}`);
  setStatus(`{yellow-fg}Connection failed. Retrying in ${remaining}s... (attempt ${retryAttempt}){/}`);

  // Countdown display
  retryCountdown = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      updateStatus(`{red-fg}Retry in ${remaining}s{/}`);
      setStatus(`{yellow-fg}Retrying in ${remaining}s... (attempt ${retryAttempt}){/}`);
    }
  }, 1000);

  retryTimer = setTimeout(() => {
    if (retryCountdown) {
      clearInterval(retryCountdown);
      retryCountdown = null;
    }
    connect();
  }, delay);
}

function cancelRetry() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (retryCountdown) {
    clearInterval(retryCountdown);
    retryCountdown = null;
  }
}

async function connect() {
  cancelRetry();
  setStatus('Connecting...');
  updateStatus('Connecting...');

  try {
    if (config.connectionType === 'ble') {
      state.connection = new NodeJSBleConnection(logTUI);
      await state.connection.connect(config.ble?.deviceName, config.ble?.scanTimeout || 30000);
    } else {
      state.connection = new NodeJSSerialConnection(config.serialPort);
      await state.connection.connect();
    }

    // Reset retry counter on successful connection
    retryAttempt = 0;

    state.connection.on('connected', onConnected);
    state.connection.on('disconnected', onDisconnected);
    state.connection.on(Constants.PushCodes.MsgWaiting, () => {
      debugLog('MsgWaiting push notification received');
      setStatus('{yellow-fg}New messages available, syncing...{/}');
      processMessages();
    });
    state.connection.on(Constants.PushCodes.SendConfirmed, onSendConfirmed);

  } catch (err) {
    debugLog(`Connection error: ${err.message}`);
    state.connected = false;
    scheduleRetry();
  }
}

async function onConnected() {
  state.connected = true;
  setStatus('Loading device info...');

  try {
    state.selfInfo = await state.connection.getSelfInfo();
    debugLog(`Self info: ${state.selfInfo?.name}`);
    await state.connection.syncDeviceTime();

    // Fetch contacts
    setStatus('Loading contacts...');
    const contacts = await state.connection.getContacts();
    state.contacts = contacts.map(c => ({
      name: c.advName,
      publicKey: c.publicKey,
      type: c.type,
    }));
    debugLog(`Loaded ${state.contacts.length} contacts`);
    // Debug: log each contact's type
    for (const c of state.contacts) {
      debugLog(`  Contact: ${c.name}, type=${c.type} (${c.type === AdvType.Chat ? 'Chat' : c.type === AdvType.Repeater ? 'Repeater' : c.type === AdvType.Room ? 'Room' : 'Unknown'})`);
    }

    // Fetch channels from device
    setStatus('Loading channels...');
    try {
      const channels = await state.connection.getChannels();
      debugLog(`Got channels: ${JSON.stringify(channels)}`);
      // Filter out empty/unnamed channels and map correctly (API returns channelIdx, not index)
      state.channels = channels
        .filter(ch => ch.name && ch.name.trim() !== '')
        .map(ch => ({
          idx: ch.channelIdx,
          name: ch.name,
        }));
      debugLog(`Loaded ${state.channels.length} named channels`);
    } catch (chErr) {
      debugLog(`Failed to get channels: ${chErr.message}`);
      // Fallback to Public channel if can't fetch
      state.channels = [{ idx: 0, name: 'Public' }];
    }

    // Ensure we have at least Public channel and it's selected
    if (state.channels.length === 0) {
      state.channels = [{ idx: 0, name: 'Public' }];
    }

    // Update selected chat if current selection is invalid
    if (state.selectedChat.type === 'channel') {
      const exists = state.channels.find(ch => ch.idx === state.selectedChat.idx);
      if (!exists) {
        state.selectedChat = { type: 'channel', idx: state.channels[0].idx, name: state.channels[0].name };
      }
    }

    // Sync any waiting messages from device
    setStatus('Syncing messages...');
    debugLog('Starting initial message sync...');
    await processMessages();
    debugLog('Initial message sync complete');

    updateStatus('{green-fg}Connected{/}');
    updateSidebar();
    updateChatHeader();
    renderMessages();
    setStatus('{green-fg}Ready! Press [3] to type, [1] for chats, [2] toggle AI{/}');

    // Poll for new messages
    const pollInterval = config.pollInterval || 2000;
    debugLog(`Starting message poll every ${pollInterval}ms`);
    setInterval(() => {
      if (state.connected) {
        processMessages();
      }
    }, pollInterval);

  } catch (err) {
    debugLog(`Init error: ${err.message}`);
    setStatus(`{red-fg}Init error: ${err.message}{/}`);
  }
}

function onDisconnected() {
  state.connected = false;
  debugLog('Device disconnected');
  // Reset retry counter for faster initial reconnect after disconnect
  retryAttempt = 0;
  scheduleRetry();
}

function onSendConfirmed(data) {
  const pending = state.pendingMessages.get(data.ackCode);
  if (pending) {
    clearTimeout(pending.timeout);
    state.pendingMessages.delete(data.ackCode);
    updateMessageStatus(pending.msgId, 'delivered');
    setStatus(`{green-fg}Delivered! (RTT: ${data.roundTrip}ms){/}`);
  }
}

let isProcessing = false;
async function processMessages() {
  if (!state.connected || isProcessing) return;
  isProcessing = true;

  try {
    let msgCount = 0;
    while (true) {
      const message = await state.connection.syncNextMessage();
      if (!message) {
        if (msgCount > 0) {
          debugLog(`Synced ${msgCount} messages from device`);
        }
        break;
      }

      msgCount++;
      debugLog(`Processing message ${msgCount}: ${JSON.stringify(Object.keys(message))}`);

      if (message.contactMessage) {
        debugLog(`Contact message: ${JSON.stringify(message.contactMessage)}`);
        await handleContactMessage(message.contactMessage);
      } else if (message.channelMessage) {
        debugLog(`Channel message: ${JSON.stringify(message.channelMessage)}`);
        await handleChannelMessage(message.channelMessage);
      } else {
        debugLog(`Unknown message type: ${JSON.stringify(message)}`);
      }
    }
  } catch (err) {
    debugLog(`processMessages error: ${err.message}`);
  } finally {
    isProcessing = false;
  }
}

async function handleContactMessage(msg) {
  const contact = state.contacts.find(c =>
    BufferUtils.bytesToHex(c.publicKey.subarray(0, 6)) === BufferUtils.bytesToHex(msg.pubKeyPrefix)
  );
  const senderName = contact?.name || BufferUtils.bytesToHex(msg.pubKeyPrefix).substring(0, 12);

  addMessage({
    id: Date.now().toString(),
    type: 'direct',
    contactName: senderName,
    text: msg.text,
    sender: senderName,
    outgoing: false,
    timestamp: Date.now(),
  });

  setStatus(`{cyan-fg}New DM from ${senderName}{/}`);

  if (state.aiEnabled && config.respondToDirectMessages !== false) {
    const response = await queryOllama(msg.text);
    if (response && contact) {
      const aiMsgId = Date.now().toString();
      addMessage({
        id: aiMsgId,
        type: 'direct',
        contactName: senderName,
        text: response,
        sender: state.selfInfo?.name || 'Bot',
        outgoing: true,
        isAI: true,
        status: 'sending',
        timestamp: Date.now(),
      });

      try {
        await state.connection.sendTextMessage(contact.publicKey, response);
        updateMessageStatus(aiMsgId, 'sent');
      } catch {
        updateMessageStatus(aiMsgId, 'failed');
      }
    }
  }
}

async function handleChannelMessage(msg) {
  // Look up actual channel name
  const channel = state.channels.find(ch => ch.idx === msg.channelIdx);
  const channelName = channel?.name || (msg.channelIdx === 0 ? 'Public' : `Channel ${msg.channelIdx}`);

  // Try to get sender name from senderName field or pubKeyPrefix
  let senderName = msg.senderName || 'Unknown';
  if (msg.pubKeyPrefix && senderName === 'Unknown') {
    // Try to find contact by public key prefix
    const contact = state.contacts.find(c =>
      BufferUtils.bytesToHex(c.publicKey.subarray(0, 6)) === BufferUtils.bytesToHex(msg.pubKeyPrefix)
    );
    if (contact) {
      senderName = contact.name;
    }
  }

  addMessage({
    id: Date.now().toString(),
    type: 'channel',
    channelIdx: msg.channelIdx,
    text: msg.text,
    sender: senderName,
    outgoing: false,
    timestamp: msg.timestamp || Date.now(),
  });

  setStatus(`{cyan-fg}New message in ${channelName} from ${senderName}{/}`);

  if (state.aiEnabled && config.respondToChannelMessages !== false) {
    const botName = config.botName || state.selfInfo?.name || '';
    if (botName && msg.text.toLowerCase().includes(botName.toLowerCase())) {
      const query = msg.text.replace(new RegExp(botName, 'gi'), '').trim();
      const response = await queryOllama(query || 'hello');
      if (response) {
        const aiMsgId = Date.now().toString();
        addMessage({
          id: aiMsgId,
          type: 'channel',
          channelIdx: msg.channelIdx,
          text: response,
          sender: state.selfInfo?.name || 'Bot',
          outgoing: true,
          isAI: true,
          status: 'sending',
          timestamp: Date.now(),
        });

        try {
          await state.connection.sendChannelTextMessage(msg.channelIdx, response);
          updateMessageStatus(aiMsgId, 'sent');
        } catch {
          updateMessageStatus(aiMsgId, 'failed');
        }
      }
    }
  }
}

async function queryOllama(prompt) {
  try {
    const response = await fetch(`${config.ollama.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        prompt,
        system: config.ollama.systemPrompt,
        stream: false,
        options: { num_predict: config.ollama.maxResponseLength },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    let reply = data.response?.trim() || '';

    if (reply.length > config.ollama.maxResponseLength) {
      reply = reply.substring(0, config.ollama.maxResponseLength - 3) + '...';
    }

    return reply;
  } catch {
    return null;
  }
}

// ============================================
// Start
// ============================================
updateAIButton();
updateStatus('Starting...');
updateSidebar();
updateChatHeader();
sidebar.focus();
screen.render();

connect();
