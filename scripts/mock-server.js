// 本地 mock 服务：模拟 DeepSeek 官方余额接口，用于开发/测试
// 用法：node scripts/mock-server.js [端口] [余额或逗号分隔的余额列表]
const http = require('http');

const port = Number(process.argv[2] || 8899);
const balances = String(process.argv[3] || '88.50').split(',');
let idx = 0;

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || '';
  console.log(`[mock] ${req.method} ${req.url} auth=${auth}`);
  if (req.url === '/user/balance') {
    if (!auth.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid key' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const total = balances[idx % balances.length];
    idx++;
    res.end(JSON.stringify({
      is_available: true,
      balance_infos: [{
        currency: 'CNY',
        total_balance: total,
        granted_balance: '0.00',
        topped_up_balance: total,
      }],
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock] DeepSeek 余额 mock 服务已启动: http://127.0.0.1:${port}/user/balance`);
});
