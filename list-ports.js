// Helper script to list available serial ports
import { SerialPort } from 'serialport';

async function listPorts() {
  const ports = await SerialPort.list();

  if (ports.length === 0) {
    console.log('No serial ports found.');
    console.log('Make sure your Heltec device is connected via USB.');
    return;
  }

  console.log('Available serial ports:\n');
  for (const port of ports) {
    console.log(`  ${port.path}`);
    if (port.manufacturer) console.log(`    Manufacturer: ${port.manufacturer}`);
    if (port.serialNumber) console.log(`    Serial: ${port.serialNumber}`);
    if (port.vendorId) console.log(`    VID: ${port.vendorId}, PID: ${port.productId}`);
    console.log();
  }
}

listPorts().catch(console.error);
