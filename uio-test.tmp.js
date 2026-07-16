const { uIOhook } = require('uiohook-napi');
uIOhook.on('keydown', (e) => console.log('KEYDOWN', e.keycode));
uIOhook.start();
console.log('hook started, waiting 8s for events...');
setTimeout(() => { uIOhook.stop(); console.log('done'); process.exit(0); }, 8000);
