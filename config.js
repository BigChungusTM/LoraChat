// Configuration for LoRa Chat Bridge

export default {
  // Connection type: 'ble' or 'serial'
  connectionType: 'ble',

  // BLE settings (used when connectionType is 'ble')
  ble: {
    // Optional: specify device name to connect to (null = first MeshCore device found)
    deviceName: null,
    // Scan timeout in milliseconds
    scanTimeout: 30000,
  },

  // Serial port settings (used when connectionType is 'serial')
  serialPort: 'COM5',

  // Ollama settings
  ollama: {
    host: 'http://localhost:11434',
    model: 'gemini-3-flash-preview:cloud',  // Change to your preferred model
    // System prompt for the chatbot
    systemPrompt: 'You are a helpful assistant responding via LoRa mesh network. Keep responses concise (under 200 characters) due to bandwidth limitations.',
    // Max response length (LoRa packets are limited)
    maxResponseLength: 200,
  },

  // Mention detection - the bot responds when its name is mentioned
  // If null, uses the device's advertised name from MeshCore
  botName: null,

  // Message polling interval in milliseconds
  pollInterval: 2000,

  // Whether to respond to channel (public) messages
  respondToChannelMessages: true,

  // Whether to respond to direct messages
  respondToDirectMessages: true,

  // Channel index for public messages (0 = public channel)
  defaultChannel: 0,
};
