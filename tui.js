import { NodeRuntime, setRuntime, Screen, Box, Text, Button, List, Log, Textbox } from '@unblessed/node';
import { NodeJSSerialConnection, Constants, BufferUtils } from '@liamcottle/meshcore.js';
import NodeJSBleConnection, { scanForDevices, stopScan } from './ble-connection.js';
import config from './config.js';
import fs from 'fs';
import path from 'path';

// Get portable app directory (next to exe when packaged, or cwd when running from source)
const APP_DIR = process.pkg ? path.dirname(process.execPath) : process.cwd();
const DEBUG_LOG = path.join(APP_DIR, 'debug.log');

// Initialize unblessed runtime
setRuntime(new NodeRuntime());

// Suppress all console output to prevent UI corruption
const logs = [];
console.log = (...args) => logs.push(['log', ...args]);
console.error = (...args) => logs.push(['error', ...args]);

// Debug file logger
const debugLog = (msg) => {
  fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} - ${msg}\n`);
};
// Clear log on start
fs.writeFileSync(DEBUG_LOG, '--- TUI Started ---\n');

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

// Helper to get chat key for unread tracking
function getChatKey(type, idOrName) {
  return `${type}:${idOrName}`;
}

// Increment unread count for a chat
function incrementUnread(type, idOrName) {
  const key = getChatKey(type, idOrName);
  state.unreadCounts[key] = (state.unreadCounts[key] || 0) + 1;
  updateSidebar();
}

// Clear unread count for current chat
function clearCurrentUnread() {
  const key = getChatKey(
    state.selectedChat.type,
    state.selectedChat.type === 'channel' ? state.selectedChat.idx : state.selectedChat.name
  );
  if (state.unreadCounts[key]) {
    delete state.unreadCounts[key];
    updateSidebar();
  }
}

// Get unread count for a chat
function getUnreadCount(type, idOrName) {
  return state.unreadCounts[getChatKey(type, idOrName)] || 0;
}

// MeshCore contact types
const AdvType = {
  None: 0,
  Chat: 1,      // Can send direct messages
  Repeater: 2,  // Relay only, cannot message
  Room: 3,      // Room server
};

// Message cache file path
const CACHE_FILE = path.join(APP_DIR, 'message-cache.json');

// Load cached messages from file
function loadMessageCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const messages = data.messages || [];

      // Deduplicate cached messages
      const seen = new Set();
      const unique = messages.filter(m => {
        // Create a unique key based on content (not timestamp to catch old dupes)
        const key = `${m.type}|${m.sender}|${m.text}|${m.channelIdx || ''}|${m.contactName || ''}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });

      debugLog(`Loaded ${unique.length} cached messages (${messages.length - unique.length} duplicates removed)`);
      return unique;
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
  selectedChat: { type: 'channel', idx: 0, name: 'Public' },
  focusedElement: 'sidebar',
  unreadCounts: {},  // Track unread messages per chat: { 'channel:0': 2, 'direct:Name': 1 }
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
  content: '{gray-fg}[1]Chats [2]Send [3]Scan [Q]uit{/}',
  tags: true,
  mouse: false,
  style: { bg: 'blue' },
});

// Scan Button
const scanButton = new Button({
  parent: headerBar,
  top: 0,
  right: 12,
  width: 10,
  height: 3,
  content: ' Scan ',
  align: 'center',
  valign: 'middle',
  tags: true,
  mouse: true,
  keys: false,
  style: {
    bg: 'magenta',
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
      const unread = getUnreadCount('channel', ch.idx);
      const unreadBadge = unread > 0 ? ` {red-fg}{bold}(${unread}){/}` : '';
      const nameStyle = unread > 0 ? '{bold}{white-fg}' : '{white-fg}';
      items.push(`${sel}{green-fg}#{/} ${nameStyle}${ch.name}{/}${unreadBadge}`);
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
      const unread = getUnreadCount('direct', contact.name);
      const unreadBadge = unread > 0 ? ` {red-fg}{bold}(${unread}){/}` : '';
      const nameStyle = unread > 0 ? '{bold}{white-fg}' : '{white-fg}';
      items.push(`${sel}{yellow-fg}@{/} ${nameStyle}${contact.name}{/}${unreadBadge}`);
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
      const unread = getUnreadCount('direct', room.name);
      const unreadBadge = unread > 0 ? ` {red-fg}{bold}(${unread}){/}` : '';
      const nameStyle = unread > 0 ? '{bold}{white-fg}' : '{white-fg}';
      items.push(`${sel}{magenta-fg}⌂{/} ${nameStyle}${room.name}{/}${unreadBadge}`);
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

// Enable scroll wheel on sidebar
sidebar.on('wheeldown', () => {
  sidebar.down(3);
  screen.render();
});

sidebar.on('wheelup', () => {
  sidebar.up(3);
  screen.render();
});

sidebar.on('select', (item, index) => {
  const text = stripTags(item.content).trim();

  // Ignore headers, empty lines, and "No X" messages
  if (text.startsWith('──') || text === '' || text.startsWith('No ')) return;

  // Ignore repeaters (shown with ◇)
  if (text.includes('◇')) {
    setStatus('{yellow-fg}Repeaters relay messages but cannot receive direct messages{/}');
    return;
  }

  // Remove leading selector arrow and trailing unread badge (number)
  let cleanText = text.replace(/^►\s*/, '').replace(/\s*\(\d+\)\s*$/, '').trim();

  // Channel: starts with "# " (the display symbol)
  if (cleanText.startsWith('# ')) {
    // Remove the display "# " prefix to get actual channel name
    const name = cleanText.substring(2).trim();
    debugLog(`Sidebar select channel: "${name}"`);
    const ch = state.channels.find(c => c.name === name);
    if (ch) {
      selectChat('channel', ch.idx, ch.name);
    } else {
      debugLog(`Channel not found: "${name}", channels: ${JSON.stringify(state.channels.map(c => c.name))}`);
    }
  } else if (cleanText.startsWith('@ ')) {
    // Contact: starts with "@ "
    const name = cleanText.substring(2).trim();
    debugLog(`Sidebar select contact: "${name}"`);
    selectChat('direct', null, name);
  } else if (cleanText.startsWith('⌂ ')) {
    // Room: starts with "⌂ "
    const name = cleanText.substring(2).trim();
    debugLog(`Sidebar select room: "${name}"`);
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
  // Clear unread count for this chat
  clearCurrentUnread();
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
  height: '100%-9',  // Leave room for input area (height 6)
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

const messageList = new Box({
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
  scrollbar: {
    ch: '█',
    track: { bg: 'gray' },
    style: { bg: 'cyan', fg: 'cyan' },
  },
});

// Enable scroll wheel on message list
messageList.on('wheeldown', () => {
  messageList.scroll(3);
  screen.render();
});

messageList.on('wheelup', () => {
  messageList.scroll(-3);
  screen.render();
});

function updateChatHeader() {
  const prefix = state.selectedChat.type === 'channel' ? '#' : '@';
  chatHeader.setContent(`{bold}${prefix} ${state.selectedChat.name}{/}`);
  screen.render();
}

function addMessage(msg) {
  debugLog(`addMessage called: type=${msg.type}, sender=${msg.sender}, text="${msg.text?.substring(0, 30)}..."`);

  // Check for duplicate by ID first, then by content
  const isDuplicate = state.messages.some(m =>
    m.id === msg.id ||
    (m.sender === msg.sender &&
     m.text === msg.text &&
     m.type === msg.type &&
     (m.type === 'channel' ? m.channelIdx === msg.channelIdx : m.contactName === msg.contactName))
  );

  if (!isDuplicate) {
    state.messages.push(msg);
    saveMessageCache();  // Persist to disk
    debugLog(`Message added, total messages: ${state.messages.length}`);
  } else {
    debugLog(`Message rejected as duplicate`);
  }
  renderMessages();
}

function renderMessages() {
  const filtered = state.messages.filter(m => {
    if (state.selectedChat.type === 'channel') {
      return m.type === 'channel' && m.channelIdx === state.selectedChat.idx;
    }
    return m.type === 'direct' && m.contactName === state.selectedChat.name;
  });

  debugLog(`renderMessages: selectedChat=${state.selectedChat.type}:${state.selectedChat.name || state.selectedChat.idx}, total=${state.messages.length}, filtered=${filtered.length}`);

  if (filtered.length === 0) {
    messageList.setContent('{gray-fg}No messages yet{/}');
    screen.render();
    return;
  }

  // Build all lines at once to avoid duplication from log() appending
  const lines = [];
  for (const msg of filtered) {
    // Handle missing or invalid timestamps - use white color for visibility
    let time = '--:--';
    if (msg.timestamp) {
      const date = new Date(msg.timestamp);
      if (!isNaN(date.getTime())) {
        time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      }
    }

    // Handle sender display
    let sender;
    if (msg.outgoing) {
      sender = '{green-fg}You{/}';
    } else if (msg.type === 'channel') {
      // For channel messages, hide sender entirely (just show message)
      sender = null;
    } else if (msg.sender) {
      sender = `{cyan-fg}${msg.sender}{/}`;
    } else {
      sender = null;
    }

    // Status icons for outgoing messages
    let statusIcon = '';
    if (msg.outgoing) {
      switch (msg.status) {
        case 'sending': statusIcon = ' {yellow-fg}◌{/}'; break;
        case 'sent': statusIcon = ' {blue-fg}✓{/}'; break;
        case 'delivered': statusIcon = ' {green-fg}✓✓{/}'; break;
        case 'failed': statusIcon = ' {red-fg}✗{/}'; break;
        default: statusIcon = ''; break;
      }
    }

    // Format line based on whether we have a sender
    if (sender) {
      lines.push(`{white-fg}[${time}]{/} ${sender}: ${msg.text}${statusIcon}`);
    } else {
      lines.push(`{white-fg}[${time}]{/} ${msg.text}${statusIcon}`);
    }
  }

  // Set all content at once (replaces instead of appending)
  messageList.setContent(lines.join('\n'));
  // Scroll to bottom after content update
  process.nextTick(() => {
    messageList.setScrollPerc(100);
    screen.render();
  });
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
  height: 6,
  border: { type: 'line' },
  label: ' {bold}Message [3]{/} ',
  tags: true,
  style: { border: { fg: 'green' } },
});

// Status text inside input area (top line)
const statusText = new Text({
  parent: inputArea,
  top: 0,
  left: 1,
  right: 15,
  height: 1,
  tags: true,
  content: '{gray-fg}Ready{/}',
  style: { fg: 'gray' },
});

// Byte counter for message length
const MAX_MESSAGE_BYTES = 200;  // MeshCore message limit

const byteCounter = new Text({
  parent: inputArea,
  top: 0,
  right: 1,
  width: 12,
  height: 1,
  tags: true,
  align: 'right',
  content: `{gray-fg}0/${MAX_MESSAGE_BYTES}{/}`,
  style: { fg: 'gray' },
});

// Helper to get byte length of string (UTF-8)
function getByteLength(str) {
  return Buffer.byteLength(str, 'utf8');
}

// Update byte counter display
function updateByteCounter(text) {
  const bytes = getByteLength(text || '');
  let color = 'gray';
  if (bytes > MAX_MESSAGE_BYTES) {
    color = 'red';
  } else if (bytes > MAX_MESSAGE_BYTES * 0.8) {
    color = 'yellow';
  } else if (bytes > 0) {
    color = 'green';
  }
  byteCounter.setContent(`{${color}-fg}${bytes}/${MAX_MESSAGE_BYTES}{/}`);
}

// Container box with border for the text input
const inputBoxContainer = new Box({
  parent: inputArea,
  top: 1,
  left: 0,
  right: 12,
  height: 3,
  border: { type: 'line' },
  style: {
    border: { fg: 'white' },
    focus: { border: { fg: 'yellow' } },
  },
});

const inputBox = new Textbox({
  parent: inputBoxContainer,
  top: 0,
  left: 0,
  right: 0,
  height: 1,
  keys: false,  // We handle keys manually
  mouse: true,
  inputOnFocus: false,
  style: {
    fg: 'white',
    bg: 'black',
    focus: { fg: 'yellow', bg: 'black' },
  },
});

// Simple focus function - no readInput callback needed
function focusInputBox() {
  inputBox.focus();
  screen.render();
}

// Click on inputBox or its container to focus
inputBox.on('click', () => {
  debugLog('inputBox CLICKED');
  focusInputBox();
});

inputBoxContainer.on('click', () => {
  debugLog('inputBoxContainer CLICKED');
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
      const bytes = getByteLength(text.trim());
      if (bytes > MAX_MESSAGE_BYTES) {
        setStatus(`{red-fg}Message too long (${bytes}/${MAX_MESSAGE_BYTES} bytes){/}`);
        return;
      }
      sendMessage(text.trim());
    }
    inputBox.clearValue();
    updateByteCounter('');
    screen.render();
  } else if (key.name === 'escape') {
    // Escape to cancel and go back to sidebar
    inputBox.clearValue();
    updateByteCounter('');
    sidebar.focus();
    screen.render();
  } else if (key.name === 'backspace') {
    // Handle backspace
    const val = inputBox.getValue();
    if (val.length > 0) {
      inputBox.setValue(val.slice(0, -1));
      updateByteCounter(inputBox.getValue());
      screen.render();
    }
  } else if (ch && !key.ctrl && !key.meta) {
    // Regular character - append to value
    const val = inputBox.getValue() || '';
    inputBox.setValue(val + ch);
    updateByteCounter(inputBox.getValue());
    screen.render();
  }
});

const sendButton = new Button({
  parent: inputArea,
  top: 1,
  right: 0,
  width: 10,
  height: 3,
  content: ' Send ',
  align: 'center',
  valign: 'middle',
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

function setStatus(msg) {
  statusText.setContent(msg);
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
screen.key(['2'], () => focusInput());
screen.key(['3'], () => showDeviceScanner());
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
quitButton.on('press', () => {
  debugLog('EXITING via quit button press');
  process.exit(0);
});
sendButton.on('press', () => {
  const text = inputBox.getValue();
  if (text && text.trim()) {
    const bytes = getByteLength(text.trim());
    if (bytes > MAX_MESSAGE_BYTES) {
      setStatus(`{red-fg}Message too long (${bytes}/${MAX_MESSAGE_BYTES} bytes){/}`);
      return;
    }
    sendMessage(text.trim());
    inputBox.clearValue();
    updateByteCounter('');
  }
});

// ============================================
// Device Scanner Modal
// ============================================
let scannerOverlay = null;
let scannerModal = null;
let deviceList = null;
let scannerStatus = null;
let scannedDevices = [];
let isScanning = false;

function createScannerModal() {
  // Dark overlay behind modal (click to close)
  scannerOverlay = new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    style: { bg: 'black', transparent: true },
  });

  scannerOverlay.on('click', () => {
    closeScannerModal();
  });

  // Modal window
  scannerModal = new Box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '60%',
    height: '70%',
    border: { type: 'line' },
    label: ' {bold}Scan for MeshCore Devices [4]{/} ',
    tags: true,
    style: {
      border: { fg: 'magenta' },
      bg: 'black',
    },
    shadow: true,
  });

  // Status text
  scannerStatus = new Text({
    parent: scannerModal,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    content: '{yellow-fg}Starting scan...{/}',
  });

  // Device list
  deviceList = new List({
    parent: scannerModal,
    top: 2,
    left: 0,
    right: 0,
    bottom: 3,
    tags: true,
    keys: true,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
    },
    scrollbar: { ch: '█', style: { bg: 'cyan' } },
  });

  // Instructions
  const instructions = new Text({
    parent: scannerModal,
    bottom: 0,
    left: 1,
    right: 1,
    height: 2,
    tags: true,
    content: '{white-fg}[Enter]{/} {gray-fg}Connect{/}  {white-fg}[S]{/} {gray-fg}Rescan{/}  {white-fg}[Esc]{/} {gray-fg}Close{/}',
  });

  // Key handlers for modal
  scannerModal.key(['escape', 'q'], () => {
    closeScannerModal();
  });

  // Also handle escape on the device list
  deviceList.key(['escape', 'q'], () => {
    closeScannerModal();
  });

  scannerModal.key(['s', 'S'], () => {
    if (isScanning) {
      stopDeviceScan();
    } else {
      startDeviceScan();
    }
  });

  scannerModal.key(['enter'], () => {
    const selected = deviceList.selected;
    if (scannedDevices[selected]) {
      connectToScannedDevice(scannedDevices[selected]);
    }
  });

  // Scroll wheel for device list
  deviceList.on('wheeldown', () => {
    deviceList.down(1);
    screen.render();
  });

  deviceList.on('wheelup', () => {
    deviceList.up(1);
    screen.render();
  });

  // Double-click to connect
  deviceList.on('select', (item, index) => {
    if (scannedDevices[index]) {
      connectToScannedDevice(scannedDevices[index]);
    }
  });
}

function showScannerModal() {
  if (!scannerModal) {
    createScannerModal();
  }
  scannedDevices = [];
  updateDeviceList();
  scannerOverlay.show();
  scannerModal.show();
  deviceList.focus();
  screen.render();

  // Auto-start scanning when opened (if not already connected)
  if (!state.connected) {
    setTimeout(() => startDeviceScan(), 100);
  } else {
    scannerStatus.setContent('{green-fg}Already connected. Press [S] to scan for other devices.{/}');
    screen.render();
  }
}

function closeScannerModal() {
  if (isScanning) {
    stopDeviceScan();
  }
  if (scannerOverlay) {
    scannerOverlay.hide();
  }
  if (scannerModal) {
    scannerModal.hide();
  }
  sidebar.focus();
  screen.render();
}

function startDeviceScan() {
  if (isScanning) return;
  isScanning = true;
  scannedDevices = [];
  updateDeviceList();
  scannerStatus.setContent('{yellow-fg}Scanning for devices...{/}');
  screen.render();

  scanForDevices(15000, (devices) => {
    // Callback called whenever devices are found/updated
    scannedDevices = devices;
    updateDeviceList();
  }).then((devices) => {
    isScanning = false;
    scannedDevices = devices;
    updateDeviceList();
    if (devices.length === 0) {
      scannerStatus.setContent('{red-fg}No devices found. Press [S] to scan again.{/}');
    } else {
      scannerStatus.setContent(`{green-fg}Found ${devices.length} device(s). Select and press Enter to connect.{/}`);
    }
    screen.render();
  }).catch((err) => {
    isScanning = false;
    scannerStatus.setContent(`{red-fg}Scan error: ${err.message}{/}`);
    screen.render();
  });
}

function stopDeviceScan() {
  isScanning = false;
  stopScan();
  scannerStatus.setContent(`{gray-fg}Scan stopped. Found ${scannedDevices.length} device(s).{/}`);
  screen.render();
}

function updateDeviceList() {
  if (!deviceList) return;

  if (scannedDevices.length === 0) {
    deviceList.setItems(['  No devices found yet...']);
  } else {
    const items = scannedDevices.map((d, i) => {
      const rssiBar = getRssiBar(d.rssi);
      // Use plain text - the list widget handles selection highlighting
      return `  ${d.name} (${d.rssi} dBm) ${rssiBar}`;
    });
    deviceList.setItems(items);
  }
  screen.render();
}

function getRssiBar(rssi) {
  // RSSI typically ranges from -30 (excellent) to -100 (poor)
  const normalized = Math.max(0, Math.min(100, (rssi + 100) * 1.4));
  const bars = Math.round(normalized / 20);
  // Return plain characters - colored tags don't work well in list items
  return '█'.repeat(bars) + '░'.repeat(5 - bars);
}

async function connectToScannedDevice(device) {
  closeScannerModal();
  debugLog(`Attempting to connect to: ${device.name} (${device.id})`);
  setStatus(`{yellow-fg}Connecting to ${device.name}...{/}`);
  updateStatus(`{yellow-fg}Connecting to ${device.name}...{/}`);

  try {
    // Close existing connection if any
    if (state.connection) {
      debugLog('Closing existing connection...');
      try {
        await state.connection.close();
      } catch (e) {
        debugLog(`Close error (ignored): ${e.message}`);
      }
      state.connection = null;
      state.connected = false;
    }

    // Create new connection and connect to the selected device
    debugLog('Creating new BLE connection...');
    state.connection = new NodeJSBleConnection(logTUI);

    debugLog('Calling connectToDevice...');
    await state.connection.connectToDevice(device.peripheral);
    debugLog('connectToDevice completed successfully');

    // Set up event handlers
    debugLog('Setting up event handlers...');
    state.connection.on('connected', () => {
      debugLog('Connected event fired');
      onConnected();
    });
    state.connection.on('disconnected', () => {
      debugLog('Disconnected event fired');
      onDisconnected();
    });
    state.connection.on(Constants.PushCodes.MsgWaiting, () => {
      debugLog('MsgWaiting push notification received');
      setStatus('{yellow-fg}New messages available, syncing...{/}');
      processMessages();
    });
    state.connection.on(Constants.PushCodes.SendConfirmed, onSendConfirmed);

    setStatus(`{green-fg}Connected to ${device.name}!{/}`);
    debugLog('Connection setup complete');

  } catch (err) {
    debugLog(`Connection error: ${err.message}\n${err.stack}`);
    setStatus(`{red-fg}Failed to connect: ${err.message}{/}`);
    updateStatus('{red-fg}Connection failed{/}');
    state.connection = null;
    state.connected = false;
  }
}

// Scan button and keyboard shortcut handlers
scanButton.on('press', () => {
  debugLog('Scan button pressed');
  showScannerModal();
});

screen.key(['4'], () => {
  showScannerModal();
});

// ============================================
// Message Sending
// ============================================
const MAX_RETRIES = 2;  // Retry 2 more times after initial attempt (3 total)

async function sendWithRetry(publicKey, text, msgId, attempt) {
  try {
    const result = await state.connection.sendTextMessage(publicKey, text);

    state.pendingMessages.set(result.expectedAckCrc, {
      msgId,
      attempt,
      publicKey,
      text,
      timeout: setTimeout(() => {
        if (state.pendingMessages.has(result.expectedAckCrc)) {
          const pending = state.pendingMessages.get(result.expectedAckCrc);
          state.pendingMessages.delete(result.expectedAckCrc);

          if (pending.attempt < MAX_RETRIES) {
            // Retry sending
            const nextAttempt = pending.attempt + 1;
            setStatus(`{yellow-fg}No ack, retrying (${nextAttempt}/${MAX_RETRIES})...{/}`);
            sendWithRetry(pending.publicKey, pending.text, pending.msgId, nextAttempt);
          } else {
            // Max retries reached, mark as failed
            updateMessageStatus(msgId, 'failed');
            setStatus('{red-fg}Message failed after 3 attempts{/}');
          }
        }
      }, result.estTimeout + 3000),
    });

    updateMessageStatus(msgId, 'sent');
    if (attempt === 0) {
      setStatus('{blue-fg}Sent, awaiting confirmation...{/}');
    } else {
      setStatus(`{blue-fg}Retry ${attempt}/${MAX_RETRIES} sent, awaiting confirmation...{/}`);
    }
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      setStatus(`{yellow-fg}Send error, retrying (${attempt + 1}/${MAX_RETRIES})...{/}`);
      await sendWithRetry(publicKey, text, msgId, attempt + 1);
    } else {
      updateMessageStatus(msgId, 'failed');
      setStatus(`{red-fg}Failed after 3 attempts: ${err.message}{/}`);
    }
  }
}

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
        // Send with retry logic
        await sendWithRetry(contact.publicKey, text, msgId, 0);
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
    setStatus('{green-fg}Ready! Press [2] to type, [1] for chats, [3] to scan{/}');

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

  // Increment unread if not viewing this contact
  if (!(state.selectedChat.type === 'direct' && state.selectedChat.name === senderName)) {
    incrementUnread('direct', senderName);
  }

}

async function handleChannelMessage(msg) {
  // Look up actual channel name
  const channel = state.channels.find(ch => ch.idx === msg.channelIdx);
  const channelName = channel?.name || (msg.channelIdx === 0 ? 'Public' : `Channel ${msg.channelIdx}`);

  // Try to get sender name from various possible fields
  let senderName = msg.senderName || msg.advName || msg.fromName || msg.name || null;

  // Try to find contact by public key prefix if no name found
  if (!senderName && msg.pubKeyPrefix) {
    const contact = state.contacts.find(c =>
      BufferUtils.bytesToHex(c.publicKey.subarray(0, 6)) === BufferUtils.bytesToHex(msg.pubKeyPrefix)
    );
    if (contact) {
      senderName = contact.name;
    } else {
      // Show short hex ID if no contact found
      senderName = BufferUtils.bytesToHex(msg.pubKeyPrefix).substring(0, 8);
    }
  }

  // Final fallback - leave null to indicate unknown sender
  debugLog(`Channel message sender: ${senderName}, msg fields: ${JSON.stringify(Object.keys(msg))}`);

  addMessage({
    id: Date.now().toString(),
    type: 'channel',
    channelIdx: msg.channelIdx,
    text: msg.text,
    sender: senderName,  // Can be null
    outgoing: false,
    timestamp: msg.timestamp || Date.now(),
  });

  setStatus(`{cyan-fg}New message in ${channelName}${senderName ? ` from ${senderName}` : ''}{/}`);

  // Increment unread if not viewing this channel
  if (!(state.selectedChat.type === 'channel' && state.selectedChat.idx === msg.channelIdx)) {
    incrementUnread('channel', msg.channelIdx);
  }

}

// ============================================
// Start
// ============================================
updateStatus('Starting...');
updateSidebar();
updateChatHeader();
sidebar.focus();
screen.render();

connect();
