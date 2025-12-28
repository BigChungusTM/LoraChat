// Build script - creates portable distribution with bundled Node.js
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.dirname(__dirname);  // Go up from scripts/

const DIST_DIR = path.join(PROJECT_DIR, 'dist', 'lorachat');

// Clean and create dist folder
const distParent = path.join(PROJECT_DIR, 'dist');
if (fs.existsSync(distParent)) {
  fs.rmSync(distParent, { recursive: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

console.log('Building portable LoraChat...\n');

// Copy app files
const filesToCopy = ['tui.js', 'ble-connection.js', 'config.js'];
for (const file of filesToCopy) {
  const src = path.join(PROJECT_DIR, file);
  const dest = path.join(DIST_DIR, file);
  fs.copyFileSync(src, dest);
  console.log(`  Copied ${file}`);
}

// Copy node_modules (required for native modules)
console.log('  Copying node_modules...');
const srcModules = path.join(PROJECT_DIR, 'node_modules');
const destModules = path.join(DIST_DIR, 'node_modules');
execSync(`xcopy /E /I /Q "${srcModules}" "${destModules}"`, { stdio: 'pipe' });
console.log('  Copied node_modules');

// Copy node.exe from current installation
const nodeExePath = process.execPath;
fs.copyFileSync(nodeExePath, path.join(DIST_DIR, 'node.exe'));
console.log('  Copied node.exe');

// Create launcher batch file (uses bundled node.exe if present, otherwise system node)
const batchContent = `@echo off
cd /d "%~dp0"
if exist "%~dp0node.exe" (
    "%~dp0node.exe" tui.js %*
) else (
    node tui.js %*
)
if errorlevel 1 pause
`;
fs.writeFileSync(path.join(DIST_DIR, 'lorachat.bat'), batchContent);
console.log('  Created lorachat.bat');

// Create package.json for the dist
const distPackage = {
  name: 'lorachat',
  version: '1.0.0',
  type: 'module',
  main: 'tui.js'
};
fs.writeFileSync(path.join(DIST_DIR, 'package.json'), JSON.stringify(distPackage, null, 2));

// Calculate total size
function getFolderSize(dir) {
  let size = 0;
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    if (file.isDirectory()) {
      size += getFolderSize(filePath);
    } else {
      size += fs.statSync(filePath).size;
    }
  }
  return size;
}

const totalSize = getFolderSize(DIST_DIR);
const sizeMB = (totalSize / 1024 / 1024).toFixed(1);

console.log('\n✓ Build complete!');
console.log(`\nPortable app: ${path.resolve(DIST_DIR)}`);
console.log(`Total size: ${sizeMB} MB`);
console.log('\nTo run: Double-click lorachat.bat');
console.log('Data files (message-cache.json, debug.log) stored in same folder.');
