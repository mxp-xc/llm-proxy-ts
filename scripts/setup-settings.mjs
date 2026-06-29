import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { modify, applyEdits } from 'jsonc-parser';

const SRC = 'config/settings.example.jsonc';
const DST = 'config/settings.jsonc';

copyFileSync(SRC, DST);

const text = readFileSync(DST, 'utf8');

// 让 OS 分配一个未占用的端口
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  server.close(() => {
    // AST 级修改，保留注释、trailing comma、缩进
    const edits = modify(text, ['service', 'port'], port, {
      formattingOptions: { tabSize: 2, insertSpaces: true },
    });
    writeFileSync(DST, applyEdits(text, edits));
    console.log(`port=${port}`);
  });
});
