/**
 * Меню тестовых данных для start-test-data.bat.
 * Русский текст выводит Node, а не cmd.exe: так он не ломается
 * ни на какой версии Windows и ни в какой кодировке консоли.
 */

const readline = require('readline');
const path = require('path');
const { spawn } = require('child_process');

const MODES = {
  1: { title: 'матч в разгаре', args: [] },
  2: { title: 'стадия драфта', args: ['--draft'] },
  3: { title: 'конец карты (итоги, потом выход в меню)', args: ['--end'] },
  4: { title: 'быстрая игра x10 с паузами (проверка сравнения вероятности)', args: ['--speed=10', '--pause'] },
  5: { title: 'новая карта с другим matchid', args: ['--match=7900000002'] }
};

console.log('');
console.log('  Что имитировать вместо Dota 2:');
for (const [n, m] of Object.entries(MODES)) console.log(`    ${n} — ${m.title}`);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('  Номер (Enter = 1): ', (answer) => {
  rl.close();
  const mode = MODES[answer.trim()] || MODES[1];
  console.log(`\n  Запускаю: ${mode.title}\n`);
  const child = spawn(process.execPath, [path.join(__dirname, 'mock-gsi.js'), ...mode.args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
});
