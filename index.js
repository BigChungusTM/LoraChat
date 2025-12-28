import { NodeJSSerialConnection, Constants, BufferUtils } from '@liamcottle/meshcore.js';
import NodeJSBleConnection from './ble-connection.js';
import config from './config.js';

class LoraChatBridge {
  constructor() {
    this.connection = null;
    this.selfInfo = null;
    this.botName = null;
    this.contacts = new Map(); // Cache contacts by pubkey prefix
    this.isProcessing = false;
  }

  async start() {
    console.log('LoRa Chat Bridge starting...');
    console.log(`Connection type: ${config.connectionType}`);

    // Create connection based on type
    if (config.connectionType === 'ble') {
      this.connection = new NodeJSBleConnection();
    } else {
      this.connection = new NodeJSSerialConnection(config.serialPort);
    }

    // Set up event handlers
    this.connection.on('connected', async () => {
      console.log('Connected to MeshCore device!');
      await this.onConnected();
    });

    this.connection.on('disconnected', () => {
      console.log('Disconnected from MeshCore device');
      this.scheduleReconnect();
    });

    this.connection.on('error', (err) => {
      console.error('Connection error:', err);
    });

    // Listen for push notifications about waiting messages
    this.connection.on(Constants.PushCodes.MsgWaiting, () => {
      console.log('Message waiting notification received');
      this.processWaitingMessages();
    });

    try {
      if (config.connectionType === 'ble') {
        console.log('Scanning for MeshCore BLE devices...');
        console.log('Make sure your device is NOT connected to your phone!');
        await this.connection.connect(config.ble.deviceName, config.ble.scanTimeout);
      } else {
        console.log(`Opening serial port: ${config.serialPort}...`);
        await this.connection.connect();
      }
    } catch (err) {
      console.error('Failed to connect:', err.message || err);
      this.scheduleReconnect();
    }
  }

  async onConnected() {
    try {
      // Get device info
      this.selfInfo = await this.connection.getSelfInfo();
      this.botName = config.botName || this.selfInfo.name;

      console.log(`Device name: ${this.selfInfo.name}`);
      console.log(`Bot will respond to mentions of: "${this.botName}"`);
      console.log(`Public key: ${BufferUtils.bytesToHex(this.selfInfo.publicKey)}`);

      // Sync device time
      await this.connection.syncDeviceTime();
      console.log('Device time synchronized');

      // Load contacts cache
      await this.refreshContacts();

      // Start polling for messages
      this.startMessagePolling();

      console.log('\nBot is ready! Listening for messages...\n');
    } catch (err) {
      console.error('Error during initialization:', err);
    }
  }

  async refreshContacts() {
    try {
      const contacts = await this.connection.getContacts();
      this.contacts.clear();
      for (const contact of contacts) {
        const prefix = BufferUtils.bytesToHex(contact.publicKey.subarray(0, 6));
        this.contacts.set(prefix, contact);
      }
      console.log(`Loaded ${contacts.length} contacts`);
    } catch (err) {
      console.error('Error loading contacts:', err);
    }
  }

  getContactByPubKeyPrefix(pubKeyPrefix) {
    const prefix = BufferUtils.bytesToHex(pubKeyPrefix);
    return this.contacts.get(prefix);
  }

  startMessagePolling() {
    setInterval(() => {
      this.processWaitingMessages();
    }, config.pollInterval);
  }

  async processWaitingMessages() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (true) {
        const message = await this.connection.syncNextMessage();
        if (!message) break;

        if (message.contactMessage) {
          await this.handleContactMessage(message.contactMessage);
        } else if (message.channelMessage) {
          await this.handleChannelMessage(message.channelMessage);
        }
      }
    } catch (err) {
      console.error('Error processing messages:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  async handleContactMessage(msg) {
    if (!config.respondToDirectMessages) return;

    const contact = this.getContactByPubKeyPrefix(msg.pubKeyPrefix);
    const senderName = contact?.advName || BufferUtils.bytesToHex(msg.pubKeyPrefix);

    console.log(`[DM] ${senderName}: ${msg.text}`);

    // For direct messages, always respond (no mention needed)
    const response = await this.queryOllama(msg.text, senderName);
    if (response) {
      await this.sendDirectReply(contact, response);
    }
  }

  async handleChannelMessage(msg) {
    if (!config.respondToChannelMessages) return;

    // Try to find sender from the message text format or contacts
    // Channel messages don't have pubKeyPrefix, so we parse from text if possible
    const channelName = msg.channelIdx === 0 ? 'public' : `ch${msg.channelIdx}`;
    console.log(`[${channelName}] ${msg.text}`);

    // Check for mention
    const mention = this.extractMention(msg.text);
    if (!mention) {
      console.log('  (no mention, ignoring)');
      return;
    }

    console.log('  Mention detected, processing...');
    const query = mention.query;
    const response = await this.queryOllama(query, 'mesh user');

    if (response) {
      await this.sendChannelReply(msg.channelIdx, response);
    }
  }

  extractMention(text) {
    const botNameLower = this.botName.toLowerCase();
    const textLower = text.toLowerCase();

    // Check for @botname or just botname at start
    const patterns = [
      new RegExp(`^@?${this.escapeRegex(botNameLower)}[,:]?\\s*(.*)`, 'i'),
      new RegExp(`(.*)@${this.escapeRegex(botNameLower)}\\s*(.*)`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        // Combine capture groups and trim
        const query = match.slice(1).join(' ').trim();
        return { query: query || 'hello' };
      }
    }

    // Also check if bot name appears anywhere in the message
    if (textLower.includes(botNameLower)) {
      // Remove the bot name and use rest as query
      const query = text.replace(new RegExp(this.escapeRegex(this.botName), 'gi'), '').trim();
      return { query: query || 'hello' };
    }

    return null;
  }

  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  async queryOllama(prompt, userName) {
    console.log(`  Querying Ollama (${config.ollama.model})...`);

    try {
      const response = await fetch(`${config.ollama.host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.ollama.model,
          prompt: prompt,
          system: config.ollama.systemPrompt,
          stream: false,
          options: {
            num_predict: config.ollama.maxResponseLength,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const data = await response.json();
      let reply = data.response?.trim() || '';

      // Truncate if too long
      if (reply.length > config.ollama.maxResponseLength) {
        reply = reply.substring(0, config.ollama.maxResponseLength - 3) + '...';
      }

      console.log(`  Ollama response: ${reply}`);
      return reply;
    } catch (err) {
      console.error('  Ollama error:', err.message);
      return 'Sorry, I encountered an error processing your request.';
    }
  }

  async sendDirectReply(contact, text) {
    if (!contact?.publicKey) {
      console.error('  Cannot reply: no contact info');
      return;
    }

    try {
      console.log(`  Sending DM reply to ${contact.advName}...`);
      await this.connection.sendTextMessage(contact.publicKey, text);
      console.log('  Reply sent!');
    } catch (err) {
      console.error('  Error sending reply:', err);
    }
  }

  async sendChannelReply(channelIdx, text) {
    try {
      console.log(`  Sending channel reply to ch${channelIdx}...`);
      await this.connection.sendChannelTextMessage(channelIdx, text);
      console.log('  Reply sent!');
    } catch (err) {
      console.error('  Error sending channel reply:', err);
    }
  }

  scheduleReconnect() {
    console.log('Reconnecting in 5 seconds...');
    setTimeout(() => this.start(), 5000);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  process.exit(0);
});

// Start the bridge
const bridge = new LoraChatBridge();
bridge.start().catch(console.error);
