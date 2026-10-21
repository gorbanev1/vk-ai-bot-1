
import fs from 'node:fs';
for (const file of ['src/platforms/vk/vkPublicScraper.js']) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  console.log('=== ' + file + ' ===');
  for (let i = 5240; i < 5345; i++) {
    console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
  }
}

