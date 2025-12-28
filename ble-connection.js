import noble from '@abandonware/noble';
import { Connection, Constants } from '@liamcottle/meshcore.js';

// MeshCore BLE UUIDs (Nordic UART Service)
const SERVICE_UUID = '6e400001b5a3f393e0a9e50e24dcca9e';
const RX_CHAR_UUID = '6e400002b5a3f393e0a9e50e24dcca9e'; // Write to this
const TX_CHAR_UUID = '6e400003b5a3f393e0a9e50e24dcca9e'; // Read/notify from this

class NodeJSBleConnection extends Connection {
  constructor(logFn = null) {
    super();
    this.peripheral = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this.isConnecting = false;
    this.log = logFn || (() => {}); // Silent by default
    this._stateHandler = null;
    this._discoverHandler = null;
  }

  _cleanupListeners() {
    // Remove any existing listeners to prevent stacking on retry
    if (this._stateHandler) {
      noble.removeListener('stateChange', this._stateHandler);
      this._stateHandler = null;
    }
    if (this._discoverHandler) {
      noble.removeListener('discover', this._discoverHandler);
      this._discoverHandler = null;
    }
    try {
      noble.stopScanning();
    } catch (e) {
      // Ignore - may not be scanning
    }
  }

  async connect(deviceName = null, timeout = 30000) {
    // Clean up any previous connection attempt
    this._cleanupListeners();

    return new Promise((resolve, reject) => {
      this.log('Initializing Bluetooth...');

      const timeoutId = setTimeout(() => {
        this._cleanupListeners();
        reject(new Error('BLE scan timeout - no MeshCore device found'));
      }, timeout);

      // Create handlers that we can remove later
      this._stateHandler = (state) => {
        this.log(`Bluetooth state: ${state}`);
        if (state === 'poweredOn') {
          this.log('Scanning for MeshCore devices...');
          noble.startScanning([SERVICE_UUID], false);
        } else if (state === 'poweredOff') {
          clearTimeout(timeoutId);
          this._cleanupListeners();
          reject(new Error('Bluetooth is powered off'));
        }
      };

      this._discoverHandler = async (peripheral) => {
        const name = peripheral.advertisement.localName || 'Unknown';
        this.log(`Found device: ${name}`);

        // If deviceName specified, filter by it
        if (deviceName && name !== deviceName) {
          return;
        }

        // Stop scanning, we found our device
        clearTimeout(timeoutId);
        this._cleanupListeners();

        this.log(`Connecting to ${name}...`);
        this.peripheral = peripheral;

        try {
          await this.connectToPeripheral();
          resolve();
        } catch (err) {
          reject(err);
        }
      };

      noble.on('stateChange', this._stateHandler);
      noble.on('discover', this._discoverHandler);

      // If Bluetooth is already powered on, start scanning immediately
      if (noble.state === 'poweredOn') {
        this.log('Scanning for MeshCore devices...');
        noble.startScanning([SERVICE_UUID], false);
      } else if (noble.state === 'poweredOff') {
        clearTimeout(timeoutId);
        this._cleanupListeners();
        reject(new Error('Bluetooth is powered off'));
      } else {
        this.log(`Waiting for Bluetooth (state: ${noble.state})...`);
      }
    });
  }

  async connectToPeripheral() {
    return new Promise((resolve, reject) => {
      this.peripheral.connect((err) => {
        if (err) {
          reject(new Error(`Connection failed: ${err.message}`));
          return;
        }

        this.log('Connected! Discovering services...');

        this.peripheral.once('disconnect', () => {
          this.log('Device disconnected');
          this.onDisconnected();
        });

        this.peripheral.discoverSomeServicesAndCharacteristics(
          [SERVICE_UUID],
          [RX_CHAR_UUID, TX_CHAR_UUID],
          async (err, services, characteristics) => {
            if (err) {
              reject(new Error(`Discovery failed: ${err.message}`));
              return;
            }

            // Find characteristics
            this.rxCharacteristic = characteristics.find(
              (c) => c.uuid === RX_CHAR_UUID
            );
            this.txCharacteristic = characteristics.find(
              (c) => c.uuid === TX_CHAR_UUID
            );

            if (!this.rxCharacteristic || !this.txCharacteristic) {
              reject(new Error('Required BLE characteristics not found'));
              return;
            }

            this.log('Setting up notifications...');

            // Subscribe to TX notifications
            this.txCharacteristic.subscribe((err) => {
              if (err) {
                reject(new Error(`Subscribe failed: ${err.message}`));
                return;
              }

              // Handle incoming data
              this.txCharacteristic.on('data', (data) => {
                const frame = new Uint8Array(data);
                this.onFrameReceived(frame);
              });

              this.log('BLE connection ready!');

              // Fire connected event
              this.onConnected();
              resolve();
            });
          }
        );
      });
    });
  }

  async close() {
    this._cleanupListeners();
    if (this.peripheral) {
      try {
        this.peripheral.disconnect();
      } catch (e) {
        this.log('Error disconnecting:', e.message);
      }
    }
    this.peripheral = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
  }

  async write(bytes) {
    return new Promise((resolve, reject) => {
      if (!this.rxCharacteristic) {
        reject(new Error('Not connected'));
        return;
      }

      const buffer = Buffer.from(bytes);
      this.rxCharacteristic.write(buffer, false, (err) => {
        if (err) {
          reject(new Error(`Write failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async sendToRadioFrame(frame) {
    this.emit('tx', frame);
    await this.write(frame);
  }
}

export default NodeJSBleConnection;
