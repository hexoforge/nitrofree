const bot = require('./bot');
const web = require('./web');

web.start();
bot.start().catch((e) => {
  console.error(e.message);
  console.error('Bot failed to start — web UI is still running so you can check settings.');
});
