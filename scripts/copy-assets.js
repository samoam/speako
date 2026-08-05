const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'interface', 'public');
const dest = path.join(__dirname, '..', 'dist', 'interface', 'public');

fs.mkdirSync(dest, { recursive: true });
for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
