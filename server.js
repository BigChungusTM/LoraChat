import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { NodeJSSerialConnection, Constants, BufferUtils } from '@liamcottle/meshcore.js';
import NodeJSBleConnection from './ble-connection.js';
import config from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Express + Socket.IO setup
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Chat Bridge State
const state = {
  connection: null,
  connected: false,
  selfInfo: null,
  contacts: new Map(),
  channels: [],
  messages: [], // Store recent messages
  aiEnabled: true,
  settings: { ...config },
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Web client connected');

  // Send current state to new client
  socket.emit('state', {
    connected: state.connected,
    selfInfo: state.selfInfo ? {
      name: state.selfInfo.name,
      publicKey: BufferUtils.bytesToHex(state.selfInfo.publicKey),
    } : null,
    contacts: Array.from(state.contacts.values()).map(c => ({
      name: c.advName,
      publicKey: BufferUtils.bytesToHex(c.publicKey),
      type: c.type,
    })),
    messages: state.messages,
    aiEnabled: state.aiEnabled,
  });

  // Handle toggle AI
  socket.on('toggleAI', (enabled) => {
    state.aiEnabled = enabled;
    io.emit('aiStatus', enabled);
    console.log(`AI auto-reply: ${enabled ? 'enabled' : 'disabled'}`);
  });

  // Handle send message
  socket.on('sendMessage', async (data) => {
    if (!state.connected) {
      socket.emit('error', 'Not connected to device');
      return;
    }

    try {
      if (data.type === 'channel') {
        await state.connection.sendChannelTextMessage(data.channelIdx || 0, data.text);
        addMessage({
          type: 'channel',
          channelIdx: data.channelIdx || 0,
          text: data.text,
          sender: state.selfInfo?.name || 'Me',
          outgoing: true,
          timestamp: Date.now(),
        });
      } else if (data.type === 'direct' && data.publicKey) {
        const contact = findContactByPubKey(data.publicKey);
        if (contact) {
          await state.connection.sendTextMessage(contact.publicKey, data.text);
          addMessage({
            type: 'direct',
            contact: contact.advName,
            text: data.text,
            sender: state.selfInfo?.name || 'Me',
            outgoing: true,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      console.error('Send error:', err);
      socket.emit('error', `Failed to send: ${err.message}`);
    }
  });

  // Handle reconnect request
  socket.on('reconnect', () => {
    if (!state.connected) {
      startConnection();
    }
  });

  socket.on('disconnect', () => {
    console.log('Web client disconnected');
  });
});

function findContactByPubKey(hexKey) {
  for (const contact of state.contacts.values()) {
    if (BufferUtils.bytesToHex(contact.publicKey) === hexKey) {
      return contact;
    }
  }
  return null;
}

function addMessage(msg) {
  state.messages.push(msg);
  // Keep last 100 messages
  if (state.messages.length > 100) {
    state.messages.shift();
  }
  io.emit('message', msg);
}

// MeshCore Connection
async function startConnection() {
  console.log('Starting MeshCore connection...');
  io.emit('status', 'Connecting...');

  try {
    if (config.connectionType === 'ble') {
      state.connection = new NodeJSBleConnection();
      await state.connection.connect(config.ble?.deviceName, config.ble?.scanTimeout || 30000);
    } else {
      state.connection = new NodeJSSerialConnection(config.serialPort);
      await state.connection.connect();
    }

    // Set up event handlers
    state.connection.on('connected', onConnected);
    state.connection.on('disconnected', onDisconnected);
    state.connection.on(Constants.PushCodes.MsgWaiting, processMessages);

  } catch (err) {
    console.error('Connection failed:', err.message);
    io.emit('status', `Connection failed: ${err.message}`);
    io.emit('state', { connected: false });
    setTimeout(startConnection, 5000);
  }
}

async function onConnected() {
  console.log('Connected to MeshCore device!');
  state.connected = true;

  try {
    // Get device info
    state.selfInfo = await state.connection.getSelfInfo();
    console.log(`Device: ${state.selfInfo.name}`);

    // Sync time
    await state.connection.syncDeviceTime();

    // Load contacts
    const contacts = await state.connection.getContacts();
    state.contacts.clear();
    for (const contact of contacts) {
      const prefix = BufferUtils.bytesToHex(contact.publicKey.subarray(0, 6));
      state.contacts.set(prefix, contact);
    }

    // Emit updated state
    io.emit('state', {
      connected: true,
      selfInfo: {
        name: state.selfInfo.name,
        publicKey: BufferUtils.bytesToHex(state.selfInfo.publicKey),
      },
      contacts: Array.from(state.contacts.values()).map(c => ({
        name: c.advName,
        publicKey: BufferUtils.bytesToHex(c.publicKey),
        type: c.type,
      })),
      messages: state.messages,
      aiEnabled: state.aiEnabled,
    });

    io.emit('status', 'Connected');

    // Start message polling
    setInterval(processMessages, config.pollInterval || 2000);

  } catch (err) {
    console.error('Init error:', err);
    io.emit('status', `Error: ${err.message}`);
  }
}

function onDisconnected() {
  console.log('Disconnected from device');
  state.connected = false;
  io.emit('state', { connected: false });
  io.emit('status', 'Disconnected');
  setTimeout(startConnection, 5000);
}

let isProcessing = false;
async function processMessages() {
  if (!state.connected || isProcessing) return;
  isProcessing = true;

  try {
    while (true) {
      const message = await state.connection.syncNextMessage();
      if (!message) break;

      if (message.contactMessage) {
        await handleContactMessage(message.contactMessage);
      } else if (message.channelMessage) {
        await handleChannelMessage(message.channelMessage);
      }
    }
  } catch (err) {
    console.error('Message processing error:', err);
  } finally {
    isProcessing = false;
  }
}

async function handleContactMessage(msg) {
  const contact = state.contacts.get(BufferUtils.bytesToHex(msg.pubKeyPrefix));
  const senderName = contact?.advName || BufferUtils.bytesToHex(msg.pubKeyPrefix);

  const messageData = {
    type: 'direct',
    contact: senderName,
    pubKeyPrefix: BufferUtils.bytesToHex(msg.pubKeyPrefix),
    text: msg.text,
    sender: senderName,
    outgoing: false,
    timestamp: Date.now(),
  };

  addMessage(messageData);
  console.log(`[DM] ${senderName}: ${msg.text}`);

  // AI response if enabled
  if (state.aiEnabled && config.respondToDirectMessages !== false) {
    const response = await queryOllama(msg.text);
    if (response && contact) {
      await state.connection.sendTextMessage(contact.publicKey, response);
      addMessage({
        type: 'direct',
        contact: senderName,
        text: response,
        sender: state.selfInfo?.name || 'Bot',
        outgoing: true,
        isAI: true,
        timestamp: Date.now(),
      });
    }
  }
}

async function handleChannelMessage(msg) {
  const channelName = msg.channelIdx === 0 ? 'public' : `ch${msg.channelIdx}`;

  const messageData = {
    type: 'channel',
    channelIdx: msg.channelIdx,
    channelName,
    text: msg.text,
    sender: 'Unknown', // Channel messages don't have sender info easily
    outgoing: false,
    timestamp: Date.now(),
  };

  addMessage(messageData);
  console.log(`[${channelName}] ${msg.text}`);

  // AI response if enabled and mentioned
  if (state.aiEnabled && config.respondToChannelMessages !== false) {
    const botName = config.botName || state.selfInfo?.name || '';
    if (botName && msg.text.toLowerCase().includes(botName.toLowerCase())) {
      const query = msg.text.replace(new RegExp(botName, 'gi'), '').trim();
      const response = await queryOllama(query || 'hello');
      if (response) {
        await state.connection.sendChannelTextMessage(msg.channelIdx, response);
        addMessage({
          type: 'channel',
          channelIdx: msg.channelIdx,
          channelName,
          text: response,
          sender: state.selfInfo?.name || 'Bot',
          outgoing: true,
          isAI: true,
          timestamp: Date.now(),
        });
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
        prompt: prompt,
        system: config.ollama.systemPrompt,
        stream: false,
        options: { num_predict: config.ollama.maxResponseLength },
      }),
    });

    if (!response.ok) throw new Error(`Ollama: ${response.status}`);

    const data = await response.json();
    let reply = data.response?.trim() || '';

    if (reply.length > config.ollama.maxResponseLength) {
      reply = reply.substring(0, config.ollama.maxResponseLength - 3) + '...';
    }

    return reply;
  } catch (err) {
    console.error('Ollama error:', err.message);
    return null;
  }
}

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n=================================`);
  console.log(`  LoRa Chat GUI running at:`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`=================================\n`);
  startConnection();
});
