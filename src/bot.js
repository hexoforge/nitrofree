const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Events,
} = require('discord.js');
const store = require('./store');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
const MAX_COMMANDS = 100; // Discord limit per scope

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' });

const status = { ready: false, tag: null, registered: 0, skipped: 0, lastSync: null, error: null };

function buildCommands() {
  const items = store.list();

  // /nitro <name> — autocomplete picker over everything, works even past the 100-command cap
  const nitro = new SlashCommandBuilder()
    .setName('nitro')
    .setDescription('Send any saved sticker / gif / video')
    .addStringOption((o) =>
      o.setName('name').setDescription('What to send').setRequired(true).setAutocomplete(true)
    );

  const cmds = [nitro.toJSON()];
  const room = MAX_COMMANDS - cmds.length;
  const shown = items.slice(0, room);
  for (const it of shown) {
    cmds.push(
      new SlashCommandBuilder()
        .setName(it.name)
        .setDescription(`Send ${it.name} (${it.type})`)
        .toJSON()
    );
  }
  status.registered = shown.length;
  status.skipped = Math.max(0, items.length - shown.length);
  return cmds;
}

async function syncCommands() {
  try {
    const body = buildCommands();
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(CLIENT_ID);
    await rest.put(route, { body });
    status.lastSync = Date.now();
    status.error = null;
  } catch (e) {
    status.error = e.message;
    console.error('Command sync failed:', e);
    throw e;
  }
}

async function sendItem(interaction, item) {
  if (!item) {
    return interaction.reply({ content: 'That one no longer exists.', ephemeral: true });
  }
  await interaction.deferReply();
  try {
    const filePath = path.join(store.MEDIA_DIR, item.file);
    const attachment = new AttachmentBuilder(filePath, { name: item.file });
    const payload = { files: [attachment] };
    if (item.mode === 'embed' && item.type !== 'video') {
      payload.embeds = [new EmbedBuilder().setColor(0x2b2d31).setImage(`attachment://${item.file}`)];
    }
    await interaction.editReply(payload);
  } catch (e) {
    console.error('send failed', e);
    await interaction.editReply({
      content: `Couldn't send **${item.name}** (file may be over this server's upload limit).`,
    });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete() && interaction.commandName === 'nitro') {
      const q = interaction.options.getFocused().toLowerCase();
      const out = store
        .list()
        .filter((i) => i.name.includes(q))
        .slice(0, 25)
        .map((i) => ({ name: `${i.name} (${i.type})`, value: i.name }));
      return interaction.respond(out);
    }
    if (!interaction.isChatInputCommand()) return;
    const name =
      interaction.commandName === 'nitro'
        ? interaction.options.getString('name')
        : interaction.commandName;
    await sendItem(interaction, store.get(name));
  } catch (e) {
    console.error('interaction error', e);
  }
});

async function start() {
  if (!DISCORD_TOKEN || !CLIENT_ID) {
    throw new Error('DISCORD_TOKEN and CLIENT_ID must be set');
  }
  rest.setToken(DISCORD_TOKEN);
  client.once(Events.ClientReady, async (c) => {
    status.ready = true;
    status.tag = c.user.tag;
    console.log(`Logged in as ${c.user.tag}`);
    try {
      await syncCommands();
      console.log(`Registered ${status.registered + 1} commands`);
    } catch {}
  });
  await client.login(DISCORD_TOKEN);
}

module.exports = { start, syncCommands, status };
