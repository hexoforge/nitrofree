const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
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

  // /nf add|remove|list — manage items straight from Discord (Manage Server by default)
  const nf = new SlashCommandBuilder()
    .setName('nf')
    .setDescription('Manage nitrofree items')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add an image / gif / video as a new command')
        .addAttachmentOption((o) => o.setName('file').setDescription('Paste or upload the file').setRequired(true))
        .addStringOption((o) => o.setName('name').setDescription('Command name (a-z, 0-9, - _)').setRequired(true).setMaxLength(32))
        .addStringOption((o) =>
          o.setName('mode').setDescription('How to post it').addChoices(
            { name: 'embed (images/gifs)', value: 'embed' },
            { name: 'raw file', value: 'file' }
          )
        )
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete an item')
        .addStringOption((o) => o.setName('name').setDescription('Item to delete').setRequired(true).setAutocomplete(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('List all items'));

  const cmds = [nitro.toJSON(), nf.toJSON()];
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

async function handleNf(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'list') {
    const items = store.list();
    const text = items.length ? items.map((i) => `\`/${i.name}\` (${i.type})`).join(', ') : 'Nothing yet — use `/nf add`.';
    return interaction.reply({ content: text.slice(0, 1990), ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  if (sub === 'remove') {
    try {
      const name = interaction.options.getString('name');
      store.remove(name);
      await syncCommands().catch(() => {});
      return interaction.editReply(`Removed \`${name}\`.`);
    } catch (e) {
      return interaction.editReply(e.message);
    }
  }
  // add
  const att = interaction.options.getAttachment('file');
  const name = store.sanitizeName(interaction.options.getString('name'));
  const type = store.typeFromMime((att.contentType || '').split(';')[0]);
  if (!type) return interaction.editReply('Unsupported file type (png/jpg/webp/gif/mp4/webm/mov).');
  if (att.size > MAX_MB * 1024 * 1024) return interaction.editReply(`File too big (max ${MAX_MB} MB).`);
  if (!name) return interaction.editReply('Invalid name.');
  if (store.get(name)) return interaction.editReply(`\`${name}\` already exists.`);
  let file;
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    file = crypto.randomBytes(8).toString('hex') + path.extname(att.name || '').toLowerCase();
    fs.writeFileSync(path.join(store.MEDIA_DIR, file), buf);
    store.add({
      name, file, original: att.name, type,
      mode: interaction.options.getString('mode') || 'embed',
      size: buf.length,
    });
    await syncCommands().catch(() => {});
    return interaction.editReply(`Added \`/${name}\` ✅ (the command list may take a moment to refresh)`);
  } catch (e) {
    if (file) fs.unlink(path.join(store.MEDIA_DIR, file), () => {});
    return interaction.editReply(`Failed: ${e.message}`);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete() && ['nitro', 'nf'].includes(interaction.commandName)) {
      const q = interaction.options.getFocused().toLowerCase();
      const out = store
        .list()
        .filter((i) => i.name.includes(q))
        .slice(0, 25)
        .map((i) => ({ name: `${i.name} (${i.type})`, value: i.name }));
      return interaction.respond(out);
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'nf') return handleNf(interaction);
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
