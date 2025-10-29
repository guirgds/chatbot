const fs = require('fs');
const path = require('path');

const chatbotPath = path.join(__dirname, 'src', 'chatbot.js');

console.log('=== REVERTENDO CORREÇÃO DE EMOJIS ===\n');

// Ler o arquivo atual
let content = fs.readFileSync(chatbotPath, 'utf8');

// Reverter as substituições - voltar aos emojis originais
content = content.replace(/1\./g, '1️⃣');
content = content.replace(/2\./g, '2️⃣');
content = content.replace(/3\./g, '3️⃣');
content = content.replace(/4\./g, '4️⃣');
content = content.replace(/5\./g, '5️⃣');
content = content.replace(/6\./g, '6️⃣');
content = content.replace(/7\./g, '7️⃣');
content = content.replace(/8\./g, '8️⃣');
content = content.replace(/9\./g, '9️⃣');
content = content.replace(/0\./g, '0️⃣');

// Reverter padrões específicos de código
content = content.replace(/\${i \+ 1}\./g, '${i + 1}️⃣');
content = content.replace(/`\${i \+ 1}\./g, '`${i + 1}️⃣');

console.log('✅ Números revertidos para emojis');

// Salvar o arquivo revertido
fs.writeFileSync(chatbotPath, content, 'utf8');

console.log('✅ Arquivo chatbot.js revertido com sucesso!');
console.log('\n=== REVERSÃO APLICADA ===');
console.log('Agora reinicie o servidor: npm start');