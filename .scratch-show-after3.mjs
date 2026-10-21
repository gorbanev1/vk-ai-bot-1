
import fs from 'node:fs';
const lines = fs.readFileSync('src/platforms/vk/vkPublicScraper.js', 'utf8').split(/\r?\n/);
for (let i = 5678; i < 5750; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

