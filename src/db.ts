import pg from 'pg';

// 接続先は DATABASE_URL（例: postgres://user:password@localhost:5432/dbname）
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** 起動時にテーブルを用意する（すでにあれば何もしない） */
export const initDatabase = async (): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      guild_id       text        NOT NULL,
      user_id        text        NOT NULL,
      character_name text        NOT NULL,
      comment        text        NOT NULL DEFAULT '',
      progress       text,
      data_center    text,
      world          text,
      start_hour     smallint,
      end_hour       smallint,
      jobs           text[]      NOT NULL DEFAULT '{}',
      channel_id     text,
      message_id     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // サーバーを抜けた日時。抜けた人のプロフィールは、戻ってきたときのために消さずに残す（登録済みとしては扱わない）
  await pool.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS left_at timestamptz');

  // プロフィールの申請。status は pending（審査中）/ approved（許可）/ rejected（拒否）/ kicked（キック）/
  // banned（BAN）/ superseded（新しい申請で無効）/ left（申請者が退出して無効）。reject_reason には拒否・キック・BANの理由が入る
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_applications (
      id                bigserial   PRIMARY KEY,
      guild_id          text        NOT NULL,
      user_id           text        NOT NULL,
      character_name    text        NOT NULL,
      comment           text        NOT NULL DEFAULT '',
      data_center       text,
      world             text,
      start_hour        smallint,
      end_hour          smallint,
      jobs              text[]      NOT NULL DEFAULT '{}',
      status            text        NOT NULL DEFAULT 'pending',
      review_channel_id text,
      review_message_id text,
      reviewer_id       text,
      reject_reason     text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      reviewed_at       timestamptz
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS profile_applications_pending
      ON profile_applications (guild_id, user_id) WHERE status = 'pending'
  `);

  // メンバーごとの設定（自分がVCに入ったときにお知らせするか）。行がない人は全部「する」
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_settings (
      guild_id            text        NOT NULL,
      user_id             text        NOT NULL,
      announce_call_start boolean     NOT NULL DEFAULT true,
      announce_vc_join    boolean     NOT NULL DEFAULT true,
      updated_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);

  // レベル（経験値）。xp は発言とVCで貯まった合計。message_count は発言の数、voice_minutes はXPになったVCの時間（分）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_levels (
      guild_id      text        NOT NULL,
      user_id       text        NOT NULL,
      xp            bigint      NOT NULL DEFAULT 0,
      message_count integer     NOT NULL DEFAULT 0,
      voice_minutes integer     NOT NULL DEFAULT 0,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);

  // 日ごと（日本時間）に貯まったXP。今日・今週・先週のランキングに使う
  await pool.query(`
    CREATE TABLE IF NOT EXISTS level_daily_xp (
      guild_id text    NOT NULL,
      day      date    NOT NULL,
      user_id  text    NOT NULL,
      xp       integer NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, day, user_id)
    )
  `);
  // ランキング掲示板（1サーバーに1つ）。last_weekly_post はどの週（その週の月曜）の結果まで投稿したか
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_boards (
      guild_id         text PRIMARY KEY,
      channel_id       text NOT NULL,
      message_id       text NOT NULL,
      last_weekly_post date
    )
  `);

  // パーティ募集。party は募集の形（full / light / free8 など）、slots は枠ごとの参加者（[{ key, userId, job }]）。
  // status は open（募集中）/ closed（締切）/ cancelled（中止）/ finished（終了）。reminded は開始前のお知らせを送ったか
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recruits (
      id         bigserial   PRIMARY KEY,
      guild_id   text        NOT NULL,
      channel_id text        NOT NULL,
      message_id text,
      host_id    text        NOT NULL,
      title      text        NOT NULL,
      comment    text        NOT NULL DEFAULT '',
      starts_at  timestamptz NOT NULL,
      party      text        NOT NULL,
      slots      jsonb       NOT NULL,
      status     text        NOT NULL DEFAULT 'open',
      reminded   boolean     NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS recruits_active ON recruits (starts_at) WHERE status IN ('open', 'closed')
  `);
  // participants は参加者（入ってよい枠・使えるジョブ・割り振られた枠）。slots は枠の設定（ジョブ指定・事前埋まり・〆）。
  // version は変更のたびに増やす（「元に戻す」で、そのあとの変更を上書きしないため）
  for (const column of [
    'thread_id text',
    'data_center text',
    'allow_duplicate_jobs boolean NOT NULL DEFAULT false',
    "mention_role_ids text[] NOT NULL DEFAULT '{}'",
    "participants jsonb NOT NULL DEFAULT '[]'",
    'version integer NOT NULL DEFAULT 0',
  ]) {
    await pool.query(`ALTER TABLE recruits ADD COLUMN IF NOT EXISTS ${column}`);
  }
  // 作成途中の募集（1人1つ）。Botを再起動しても続きから作れる
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recruit_drafts (
      guild_id   text        NOT NULL,
      user_id    text        NOT NULL,
      data       jsonb       NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // 募集のテンプレート（よく使う募集を保存しておく）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recruit_templates (
      id         bigserial   PRIMARY KEY,
      guild_id   text        NOT NULL,
      name       text        NOT NULL,
      created_by text        NOT NULL,
      data       jsonb       NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (guild_id, name)
    )
  `);
  // 募集一覧のメッセージ（1サーバーに1つ）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recruit_lists (
      guild_id   text PRIMARY KEY,
      channel_id text NOT NULL,
      message_id text NOT NULL
    )
  `);

  // 行動ログ（「ログ」チャンネルに送ったものと同じ内容）。あとから検索・CSVで出せるように残す。details は [{ name, value }]
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id          bigserial   PRIMARY KEY,
      guild_id    text        NOT NULL,
      kind        text        NOT NULL,
      title       text        NOT NULL,
      text        text        NOT NULL,
      actor_id    text,
      actor_name  text,
      target_id   text,
      target_name text,
      channel_id  text,
      details     jsonb       NOT NULL DEFAULT '[]',
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS activity_logs_time ON activity_logs (guild_id, created_at DESC)');

  // 発言の記録。Botを再起動したあとでも、消された・編集されたメッセージの内容が分かるように残す（一定期間で消す）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_logs (
      message_id  text        PRIMARY KEY,
      guild_id    text        NOT NULL,
      channel_id  text        NOT NULL,
      author_id   text        NOT NULL,
      author_name text        NOT NULL,
      content     text        NOT NULL DEFAULT '',
      attachments text[]      NOT NULL DEFAULT '{}',
      created_at  timestamptz NOT NULL,
      edited_at   timestamptz,
      deleted_at  timestamptz
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS message_logs_time ON message_logs (guild_id, created_at DESC)');

  // VCに入っていた時間。left_at が null なら今も入っている。
  // start_estimated は、Botが止まっている間に入った人（入った時刻が分からないので、Botが動き出した時刻にしてある）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id              bigserial   PRIMARY KEY,
      guild_id        text        NOT NULL,
      user_id         text        NOT NULL,
      user_name       text        NOT NULL,
      channel_id      text        NOT NULL,
      joined_at       timestamptz NOT NULL,
      left_at         timestamptz,
      start_estimated boolean     NOT NULL DEFAULT false
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS voice_sessions_open ON voice_sessions (guild_id, user_id) WHERE left_at IS NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS voice_sessions_time ON voice_sessions (guild_id, joined_at DESC)');

  // 設置したパネルの場所。起動時にパネルを最新の内容に作り直す（payload_hash は前回の内容。変わったときだけ編集する）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS panels (
      message_id   text        PRIMARY KEY,
      guild_id     text        NOT NULL,
      channel_id   text        NOT NULL,
      kind         text        NOT NULL,
      payload_hash text,
      created_at   timestamptz NOT NULL DEFAULT now()
    )
  `);
};

export const closeDatabase = (): Promise<void> => pool.end();
