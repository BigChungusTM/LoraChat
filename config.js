// Configuration for LoRa Chat

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

  // Message polling interval in milliseconds
  pollInterval: 2000,

  // Channel index for public messages (0 = public channel)
  defaultChannel: 0,
};
