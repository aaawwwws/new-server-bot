import { pool } from './db.js';

// 一時VCの入口と部屋。VCの出入りのたびにDBを読まないよう、覚えておく（DBは再起動しても続けるための控え）

export interface VoiceLobby {
  channelId: string;
  guildId: string;
  /** 部屋を作るカテゴリー（null なら入口と同じ場所） */
  categoryId: string | null;
  /** 部屋の名前。{name} は入った人の名前になる */
  nameTemplate: string;
  /** 部屋の人数の上限（0 は上限なし） */
  userLimit: number;
}

export interface VoiceRoom {
  channelId: string;
  guildId: string;
  ownerId: string;
  locked: boolean;
  /** 部屋のチャットに出した操作パネル */
  panelMessageId: string | null;
  createdAt: Date;
}

const lobbies = new Map<string, VoiceLobby>();
const rooms = new Map<string, VoiceRoom>();

/** 起動時に、全サーバーの入口と部屋を読み込む */
export const loadTempVoice = async (): Promise<void> => {
  const [lobbyRows, roomRows] = await Promise.all([
    pool.query<{ channel_id: string; guild_id: string; category_id: string | null; name_template: string; user_limit: number }>(
      'SELECT channel_id, guild_id, category_id, name_template, user_limit FROM temp_voice_lobbies',
    ),
    pool.query<{ channel_id: string; guild_id: string; owner_id: string; locked: boolean; panel_message_id: string | null; created_at: Date }>(
      'SELECT channel_id, guild_id, owner_id, locked, panel_message_id, created_at FROM temp_voice_rooms',
    ),
  ]);
  lobbies.clear();
  rooms.clear();
  for (const row of lobbyRows.rows) {
    lobbies.set(row.channel_id, {
      channelId: row.channel_id,
      guildId: row.guild_id,
      categoryId: row.category_id,
      nameTemplate: row.name_template,
      userLimit: row.user_limit,
    });
  }
  for (const row of roomRows.rows) {
    rooms.set(row.channel_id, {
      channelId: row.channel_id,
      guildId: row.guild_id,
      ownerId: row.owner_id,
      locked: row.locked,
      panelMessageId: row.panel_message_id,
      createdAt: row.created_at,
    });
  }
};

export const findLobby = (channelId: string | null | undefined): VoiceLobby | undefined => (channelId ? lobbies.get(channelId) : undefined);

export const findRoom = (channelId: string | null | undefined): VoiceRoom | undefined => (channelId ? rooms.get(channelId) : undefined);

export const listLobbies = (guildId: string): VoiceLobby[] => [...lobbies.values()].filter((lobby) => lobby.guildId === guildId);

export const listRooms = (guildId: string): VoiceRoom[] => [...rooms.values()].filter((room) => room.guildId === guildId);

export const findRoomByOwner = (guildId: string, ownerId: string): VoiceRoom | undefined =>
  listRooms(guildId).find((room) => room.ownerId === ownerId);

export const saveLobby = async (lobby: VoiceLobby): Promise<void> => {
  await pool.query(
    `INSERT INTO temp_voice_lobbies (channel_id, guild_id, category_id, name_template, user_limit) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel_id) DO UPDATE SET category_id = EXCLUDED.category_id, name_template = EXCLUDED.name_template, user_limit = EXCLUDED.user_limit`,
    [lobby.channelId, lobby.guildId, lobby.categoryId, lobby.nameTemplate, lobby.userLimit],
  );
  lobbies.set(lobby.channelId, lobby);
};

export const deleteLobby = async (channelId: string): Promise<void> => {
  await pool.query('DELETE FROM temp_voice_lobbies WHERE channel_id = $1', [channelId]);
  lobbies.delete(channelId);
};

export const saveRoom = async (room: VoiceRoom): Promise<VoiceRoom> => {
  await pool.query(
    `INSERT INTO temp_voice_rooms (channel_id, guild_id, owner_id, locked, panel_message_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, locked = EXCLUDED.locked, panel_message_id = EXCLUDED.panel_message_id`,
    [room.channelId, room.guildId, room.ownerId, room.locked, room.panelMessageId, room.createdAt],
  );
  rooms.set(room.channelId, room);
  return room;
};

export const deleteRoom = async (channelId: string): Promise<void> => {
  await pool.query('DELETE FROM temp_voice_rooms WHERE channel_id = $1', [channelId]);
  rooms.delete(channelId);
};
