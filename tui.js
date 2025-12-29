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
  right: 47,
  content: '{gray-fg}[1]Chats [2]Send [3]Scan [S]ettings [Q]uit{/}',
  tags: true,
  mouse: false,
  style: { bg: 'blue' },
});

// Settings Button
const settingsButton = new Button({
  parent: headerBar,
  top: 0,
  right: 24,
  width: 12,
  height: 3,
  content: ' Settings ',
  align: 'center',
  valign: 'middle',
  tags: true,
  mouse: true,
  keys: false,
  style: {
    bg: 'cyan',
    fg: 'black',
    hover: { bg: 'magenta' },
    focus: { bg: 'magenta' },
  },
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

// ============================================
// Context Menu
// ============================================
let contextMenu = null;
let contextMenuTarget = null;

function showContextMenu(x, y, options, target) {
  hideContextMenu();

  contextMenuTarget = target;
  const menuWidth = 20;
  const menuHeight = options.length + 2;

  // Adjust position to stay on screen
  const menuX = Math.min(x, screen.width - menuWidth - 2);
  const menuY = Math.min(y, screen.height - menuHeight - 2);

  contextMenu = new Box({
    parent: screen,
    top: menuY,
    left: menuX,
    width: menuWidth,
    height: menuHeight,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
    tags: true,
    mouse: true,
    keys: true,
  });

  options.forEach((opt, i) => {
    const btn = new Box({
      parent: contextMenu,
      top: i,
      left: 0,
      right: 0,
      height: 1,
      content: ` ${opt.label}`,
      tags: true,
      mouse: true,
      style: {
        fg: 'white',
        hover: { bg: 'blue' },
      },
    });

    btn.on('click', () => {
      hideContextMenu();
      opt.action();
    });
  });

  contextMenu.key(['escape', 'q'], hideContextMenu);
  contextMenu.focus();
  screen.render();
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.destroy();
    contextMenu = null;
    contextMenuTarget = null;
    screen.render();
  }
}

// Click anywhere else to close context menu
screen.on('mouse', (data) => {
  if (contextMenu && data.action === 'mousedown') {
    // Check if click is outside the context menu
    const mx = contextMenu.left;
    const my = contextMenu.top;
    const mw = contextMenu.width;
    const mh = contextMenu.height;
    if (data.x < mx || data.x >= mx + mw || data.y < my || data.y >= my + mh) {
      hideContextMenu();
    }
  }
});

// Right-click handler for sidebar (context menu) - use screen level to catch before sidebar
screen.on('mouse', (data) => {
  if (data.action === 'mousedown' && data.button === 'right') {
    // Check if click is within sidebar bounds
    const sidebarLeft = sidebar.aleft || 0;
    const sidebarTop = sidebar.atop || 0;
    const sidebarWidth = sidebar.width || 30;
    const sidebarHeight = sidebar.height || 20;

    if (data.x >= sidebarLeft && data.x < sidebarLeft + sidebarWidth &&
        data.y >= sidebarTop && data.y < sidebarTop + sidebarHeight) {

      debugLog(`Right-click in sidebar: x=${data.x}, y=${data.y}`);

      // Get the item at the clicked position
      const itemY = data.y - sidebarTop - (sidebar.border ? 1 : 0);
      const items = sidebar.items || [];
      debugLog(`Right-click calc: itemY=${itemY}, items.length=${items.length}`);

      if (itemY >= 0 && itemY < items.length) {
        const item = items[itemY];
        if (item) {
          const text = stripTags(item.content).trim();
          debugLog(`Right-click on: "${text}" at index=${itemY}`);

          // Check if it's a contact (has @)
          if (text.includes('@')) {
            const name = text.replace(/[►@()\d]/g, '').trim();
            const contact = state.contacts.find(c => c.name === name);
            if (contact) {
              showContextMenu(data.x, data.y, [
                { label: '{cyan-fg}@{/} ' + name, action: () => {} },
                { label: '─────────────────', action: () => {} },
                { label: 'Send Message', action: () => selectChat('direct', null, contact.name) },
                { label: 'Ping', action: () => pingContact(contact) },
                { label: 'View Info', action: () => showContactInfo(contact) },
              ], contact);
            }
          }
          // Check if it's a channel (has #)
          else if (text.includes('#')) {
            const name = text.replace(/[►#()\d]/g, '').trim();
            const channel = state.channels.find(c => c.name === name);
            if (channel) {
              showContextMenu(data.x, data.y, [
                { label: '{green-fg}#{/} ' + name, action: () => {} },
                { label: '─────────────────', action: () => {} },
                { label: 'Open Channel', action: () => selectChat('channel', channel.idx, channel.name) },
              ], channel);
            }
          }
          // Check if it's a repeater (has ◇)
          else if (text.includes('◇')) {
            const name = text.replace(/[◇]/g, '').trim();
            const repeater = state.contacts.find(c => c.name === name && c.type === AdvType.Repeater);
            if (repeater) {
              showContextMenu(data.x, data.y, [
                { label: '{yellow-fg}◇{/} ' + name, action: () => {} },
                { label: '─────────────────', action: () => {} },
                { label: 'Ping', action: () => pingContact(repeater) },
                { label: 'View Info', action: () => showContactInfo(repeater) },
              ], repeater);
            }
          }
        }
      }
    }
  }
});

async function pingContact(contact) {
  if (!state.connected || !state.connection) {
    setStatus(`{red-fg}Not connected{/}`);
    return;
  }

  setStatus(`{yellow-fg}Pinging ${contact.name}...{/}`);
  debugLog(`Pinging contact: ${contact.name}, type=${contact.type}, pubKey=${BufferUtils.bytesToHex(contact.publicKey).substring(0,12)}`);

  try {
    const start = Date.now();
    let result;

    // Use pingRepeaterZeroHop for repeaters (simpler, works better)
    if (contact.type === AdvType.Repeater) {
      debugLog(`Using pingRepeaterZeroHop for repeater`);
      result = await state.connection.pingRepeaterZeroHop(contact.publicKey, 10000);
    } else {
      // For regular contacts, try tracePath
      debugLog(`Using tracePath for contact`);
      const path = [contact.publicKey];
      result = await state.connection.tracePath(path, 5000);
    }

    const elapsed = Date.now() - start;
    debugLog(`Ping result: ${JSON.stringify(result)}`);

    // Format the result based on what we got back
    if (result) {
      let statusMsg = `{green-fg}Ping ${contact.name}: `;

      if (result.rtt !== undefined) {
        statusMsg += `${result.rtt}ms`;
      } else {
        statusMsg += `${elapsed}ms`;
      }

      if (result.snr !== undefined) {
        const snrBars = getSignalBars(result.snr);
        statusMsg += ` | SNR: ${result.snr}dB ${snrBars}`;
      }

      if (result.rssi !== undefined) {
        statusMsg += ` | RSSI: ${result.rssi}dBm`;
      }

      statusMsg += `{/}`;
      setStatus(statusMsg);
    } else {
      setStatus(`{green-fg}Ping ${contact.name}: ${elapsed}ms | Response received{/}`);
    }
  } catch (err) {
    const errorMsg = typeof err === 'string' ? err : err?.message || 'Unknown error';
    debugLog(`Ping failed: ${errorMsg}`);
    if (errorMsg === 'timeout') {
      setStatus(`{red-fg}Ping ${contact.name}: Timed out (no response){/}`);
    } else {
      setStatus(`{red-fg}Ping ${contact.name} failed: ${errorMsg}{/}`);
    }
  }
}

function getSignalBars(snr) {
  // Convert SNR to signal bars (rough approximation)
  // SNR typically ranges from -20 (bad) to +10 (excellent)
  if (snr >= 5) return '▁▃▅▇ Excellent';
  if (snr >= 0) return '▁▃▅  Good';
  if (snr >= -5) return '▁▃   Fair';
  if (snr >= -10) return '▁    Weak';
  return '▁    Poor';
}

function showContactInfo(contact) {
  const info = [
    `Name: ${contact.name}`,
    `Type: ${contact.type === AdvType.Chat ? 'Contact' : contact.type === AdvType.Repeater ? 'Repeater' : 'Room'}`,
    `Public Key: ${BufferUtils.bytesToHex(contact.publicKey).substring(0, 16)}...`,
  ].join(' | ');
  setStatus(`{cyan-fg}${info}{/}`);
}

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
// Settings Modal
// ============================================
let settingsOverlay = null;
let settingsModal = null;
let settingsTabList = null;
let settingsContent = null;
let currentSettingsTab = 'ble';

const settingsTabs = [
  { id: 'ble', label: 'BLE Connection' },
  { id: 'device', label: 'Device Info' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'radio', label: 'Radio Settings' },
];

function createSettingsModal() {
  // Dark overlay behind modal
  settingsOverlay = new Box({
    parent: screen,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    style: { bg: 'black', transparent: true },
  });

  settingsOverlay.on('click', () => {
    closeSettingsModal();
  });

  // Modal window
  settingsModal = new Box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '80%',
    height: '80%',
    border: { type: 'line' },
    label: ' {bold}Settings{/} ',
    tags: true,
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
    shadow: true,
  });

  // Tab list (left sidebar)
  settingsTabList = new List({
    parent: settingsModal,
    top: 0,
    left: 0,
    width: 20,
    bottom: 2,
    tags: true,
    keys: true,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white', bold: true },
      item: { fg: 'white' },
    },
  });

  // Separator
  const separator = new Box({
    parent: settingsModal,
    top: 0,
    left: 20,
    width: 1,
    bottom: 2,
    content: '│'.repeat(50),
    style: { fg: 'cyan' },
  });

  // Content area (right side)
  settingsContent = new Box({
    parent: settingsModal,
    top: 0,
    left: 22,
    right: 0,
    bottom: 2,
    tags: true,
    mouse: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '█', style: { bg: 'cyan' } },
  });

  // Instructions
  const instructions = new Text({
    parent: settingsModal,
    bottom: 0,
    left: 1,
    right: 1,
    height: 1,
    tags: true,
    content: '{white-fg}[↑↓]{/} {gray-fg}Navigate{/}  {white-fg}[Enter]{/} {gray-fg}Select{/}  {white-fg}[Esc]{/} {gray-fg}Close{/}',
  });

  // Populate tab list
  settingsTabList.setItems(settingsTabs.map(t => `  ${t.label}`));

  // Tab selection handler
  settingsTabList.on('select', (item, index) => {
    currentSettingsTab = settingsTabs[index].id;
    updateSettingsContent();
  });

  // Key handlers
  settingsModal.key(['escape', 'q'], () => {
    closeSettingsModal();
  });

  settingsTabList.key(['escape', 'q'], () => {
    closeSettingsModal();
  });

  // Scroll wheel support
  settingsContent.on('wheeldown', () => {
    settingsContent.scroll(3);
    screen.render();
  });

  settingsContent.on('wheelup', () => {
    settingsContent.scroll(-3);
    screen.render();
  });
}

function showSettingsModal() {
  if (!settingsModal) {
    createSettingsModal();
  }
  currentSettingsTab = 'ble';
  settingsTabList.select(0);
  settingsOverlay.show();
  settingsModal.show();
  settingsTabList.focus();
  updateSettingsContent();
  screen.render();
}

function closeSettingsModal() {
  if (settingsOverlay) {
    settingsOverlay.hide();
  }
  if (settingsModal) {
    settingsModal.hide();
  }
  sidebar.focus();
  screen.render();
}

async function updateSettingsContent() {
  if (!settingsContent) return;

  let content = '';

  switch (currentSettingsTab) {
    case 'ble':
      content = await getBleSettingsContent();
      break;
    case 'device':
      content = await getDeviceInfoContent();
      break;
    case 'telemetry':
      content = await getTelemetryContent();
      break;
    case 'radio':
      content = await getRadioSettingsContent();
      break;
  }

  settingsContent.setContent(content);
  screen.render();
}

async function getBleSettingsContent() {
  let content = '{bold}{cyan-fg}BLE Connection{/}\n';
  content += '─'.repeat(40) + '\n\n';

  if (state.connected) {
    content += '{green-fg}● Connected{/}\n\n';
    content += `{white-fg}Device:{/} ${state.selfInfo?.name || 'Unknown'}\n`;
    content += `{white-fg}Connection Type:{/} ${config.connectionType || 'BLE'}\n\n`;
    content += '{gray-fg}Use [3] Scan to connect to a different device{/}\n';
  } else {
    content += '{red-fg}● Disconnected{/}\n\n';
    content += '{yellow-fg}Press [3] or click Scan to find devices{/}\n\n';
    content += '{gray-fg}Tip: Make sure your MeshCore device has BLE enabled{/}\n';
    content += '{gray-fg}and is powered on within range.{/}\n';
  }

  content += '\n{bold}Connection Settings:{/}\n';
  content += `  Scan Timeout: ${config.ble?.scanTimeout || 30000}ms\n`;
  content += `  Poll Interval: ${config.pollInterval || 2000}ms\n`;

  return content;
}

async function getDeviceInfoContent() {
  let content = '{bold}{cyan-fg}Device Information{/}\n';
  content += '─'.repeat(40) + '\n\n';

  if (!state.connected || !state.connection) {
    content += '{red-fg}Not connected to device{/}\n';
    content += '{gray-fg}Connect to a device to view information{/}\n';
    return content;
  }

  try {
    // Get self info
    const selfInfo = state.selfInfo || await state.connection.getSelfInfo();

    content += '{bold}Device Name:{/}\n';
    content += `  {green-fg}${selfInfo?.name || 'Unknown'}{/}\n\n`;

    content += '{bold}Public Key:{/}\n';
    if (selfInfo?.publicKey) {
      const pubKeyHex = BufferUtils.bytesToHex(selfInfo.publicKey);
      // Split into readable chunks
      content += `  {yellow-fg}${pubKeyHex.substring(0, 32)}{/}\n`;
      content += `  {yellow-fg}${pubKeyHex.substring(32)}{/}\n\n`;
    } else {
      content += '  {gray-fg}Not available{/}\n\n';
    }

    // Try to get additional device info using deviceQuery
    try {
      const deviceInfo = await state.connection.deviceQuery(1);
      if (deviceInfo) {
        content += '{bold}Firmware:{/}\n';
        content += `  Version: ${deviceInfo.firmwareVer || 'Unknown'}\n`;
        if (deviceInfo.firmware_build_date) {
          content += `  Build:   ${deviceInfo.firmware_build_date}\n`;
        }
        if (deviceInfo.manufacturerModel) {
          content += `  Model:   ${deviceInfo.manufacturerModel}\n`;
        }
        content += '\n';
      }
    } catch (e) {
      debugLog(`Could not get device info: ${e.message}`);
    }

    content += '{bold}Statistics:{/}\n';
    content += `  Contacts: ${state.contacts.length}\n`;
    content += `  Channels: ${state.channels.length}\n`;
    content += `  Cached Messages: ${state.messages.length}\n`;

  } catch (err) {
    content += `{red-fg}Error fetching device info: ${err.message}{/}\n`;
  }

  return content;
}

async function getTelemetryContent() {
  let content = '{bold}{cyan-fg}Telemetry{/}\n';
  content += '─'.repeat(40) + '\n\n';

  if (!state.connected || !state.connection) {
    content += '{red-fg}Not connected to device{/}\n';
    content += '{gray-fg}Connect to a device to view telemetry{/}\n';
    return content;
  }

  try {
    // Try to get battery voltage using correct API method
    content += '{bold}Battery:{/}\n';
    try {
      const batteryResult = await state.connection.getBatteryVoltage();
      if (batteryResult && batteryResult.batteryMilliVolts) {
        const voltage = (batteryResult.batteryMilliVolts / 1000).toFixed(2);
        // Estimate percentage based on typical LiPo voltage range (3.0V - 4.2V)
        const minV = 3000, maxV = 4200;
        const percent = Math.max(0, Math.min(100, Math.round(
          ((batteryResult.batteryMilliVolts - minV) / (maxV - minV)) * 100
        )));

        content += `  Voltage: {yellow-fg}${voltage}V{/}\n`;
        content += `  Level:   ${getBatteryBar(percent)} ~${percent}%\n`;
        content += '  {gray-fg}(estimated from voltage){/}\n';
      } else {
        content += '  {gray-fg}Not available{/}\n';
      }
    } catch (e) {
      content += '  {gray-fg}Not available{/}\n';
      debugLog(`Battery info error: ${e.message}`);
    }

    content += '\n{bold}GPS Position:{/}\n';
    // GPS data comes from selfInfo if device advertises location
    if (state.selfInfo?.lat && state.selfInfo?.lon) {
      content += `  Latitude:  {green-fg}${state.selfInfo.lat.toFixed(6)}°{/}\n`;
      content += `  Longitude: {green-fg}${state.selfInfo.lon.toFixed(6)}°{/}\n`;
    } else {
      content += '  {gray-fg}No GPS position set on device{/}\n';
      content += '  {gray-fg}(Set via companion app or device menu){/}\n';
    }

    content += '\n{bold}Device Statistics:{/}\n';
    content += `  Contacts:        {white-fg}${state.contacts.length}{/}\n`;
    content += `  Channels:        {white-fg}${state.channels.length}{/}\n`;
    content += `  Cached Messages: {white-fg}${state.messages.length}{/}\n`;

  } catch (err) {
    content += `{red-fg}Error fetching telemetry: ${err.message}{/}\n`;
  }

  return content;
}

function getBatteryBar(percent) {
  const filled = Math.round(percent / 10);
  let color = 'green';
  if (percent < 20) color = 'red';
  else if (percent < 50) color = 'yellow';
  return `{${color}-fg}${'█'.repeat(filled)}${'░'.repeat(10 - filled)}{/}`;
}

async function getRadioSettingsContent() {
  let content = '{bold}{cyan-fg}Radio Settings{/}\n';
  content += '─'.repeat(40) + '\n\n';

  if (!state.connected || !state.connection) {
    content += '{red-fg}Not connected to device{/}\n';
    content += '{gray-fg}Connect to a device to view radio settings{/}\n';
    return content;
  }

  // Note: MeshCore API doesn't have a getRadioConfig method
  // Radio settings can only be SET, not READ via the companion API
  // Show device info instead and explain the limitation

  content += '{yellow-fg}Radio Configuration{/}\n\n';
  content += '{gray-fg}The MeshCore companion API does not currently{/}\n';
  content += '{gray-fg}support reading radio settings from the device.{/}\n\n';

  content += '{white-fg}Radio settings can be configured via:{/}\n';
  content += '  • MeshCore Companion App\n';
  content += '  • Device menu (if available)\n';
  content += '  • MeshCore web flasher\n\n';

  content += '{bold}Common MeshCore LoRa Settings:{/}\n\n';

  content += '{cyan-fg}Frequency Bands:{/}\n';
  content += '  EU: 869.4-869.65 MHz\n';
  content += '  US: 902-928 MHz\n';
  content += '  AU: 915-928 MHz\n\n';

  content += '{cyan-fg}Typical Settings:{/}\n';
  content += '  Bandwidth:        125-500 kHz\n';
  content += '  Spreading Factor: SF7-SF12\n';
  content += '  Coding Rate:      4/5 - 4/8\n';
  content += '  TX Power:         2-22 dBm\n\n';

  content += '{gray-fg}Higher SF = longer range but slower{/}\n';
  content += '{gray-fg}Higher BW = faster but shorter range{/}\n';

  return content;
}

// Settings button handler
settingsButton.on('press', () => {
  debugLog('Settings button pressed');
  showSettingsModal();
});

// Keyboard shortcut for settings
screen.key(['s', 'S'], () => {
  // Don't open settings if we're in input mode
  if (screen.focused === inputBox) {
    return;
  }
  showSettingsModal();
});

function showDeviceScanner() {
  showScannerModal();
}

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
