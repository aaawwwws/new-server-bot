import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN が設定されていません。.env を確認してください。');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`ログインしました: ${readyClient.user.tag}`);
});

client.login(token).catch((error: unknown) => {
  console.error('ログインに失敗しました:', error);
  process.exit(1);
});
