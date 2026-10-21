
import fs from 'node:fs';
const lines = fs.readFileSync('src/platforms/vk/vkPublicScraper.js', 'utf8').split(/\r?\n/);
for (let i = 5615; i < 5680; i++) {
  console.log(String(i + 1).padStart(6) + ': ' + lines[i]);
}

