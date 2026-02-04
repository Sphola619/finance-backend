const WebSocket = require('ws');

const API_KEY = '693525861a5662.01537050';
const ws = new WebSocket(`wss://ws.eodhistoricaldata.com/ws/us?api_token=${API_KEY}`);

ws.on('open', () => {
  console.log('✅ WebSocket connected to EODHD US equities');
  
  // Subscribe to some popular US stocks
  const subscribeMsg = {
    action: 'subscribe',
    symbols: 'AAPL.US,TSLA.US,MSFT.US,GOOGL.US,NVDA.US'
  };
  
  ws.send(JSON.stringify(subscribeMsg));
  console.log('📊 Subscribed to: AAPL.US, TSLA.US, MSFT.US, GOOGL.US, NVDA.US');
  console.log('⏱️  Listening for 15 seconds...\n');
  
  // Close after 15 seconds
  setTimeout(() => {
    console.log('\n⏱️  15 seconds elapsed, closing connection...');
    ws.close();
  }, 15000);
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    console.log('📨 Message:', JSON.stringify(msg, null, 2));
  } catch (err) {
    console.log('📨 Raw message:', data.toString());
  }
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('⚠️  WebSocket closed');
  process.exit(0);
});
