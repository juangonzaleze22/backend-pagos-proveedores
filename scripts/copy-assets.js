const fs = require('fs');
const path = require('path');

const source = path.join(process.cwd(), 'src', 'assets');
const destination = path.join(process.cwd(), 'dist', 'assets');

if (!fs.existsSync(source)) {
  console.log('ℹ️  No hay src/assets para copiar.');
  process.exit(0);
}

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });
console.log('✅ Assets copiados a dist/assets');
