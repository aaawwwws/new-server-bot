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
  // 最近やっているゲーム・コンテンツ（自由入力・任意）
  for (const table of ['profiles', 'profile_applications']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS recent text NOT NULL DEFAULT ''`);
  }
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
  // ランキングに名前を出さない設定（XPは貯まるが、順位には入らない）
  await pool.query('ALTER TABLE member_settings ADD COLUMN IF NOT EXISTS hide_from_ranking boolean NOT NULL DEFAULT false');
  // フレンド候補に自分を出さない（出さない人も、ほかの人の候補は見られる）
  await pool.query('ALTER TABLE member_settings ADD COLUMN IF NOT EXISTS hide_from_friends boolean NOT NULL DEFAULT false');

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
  // 日ごとの発言の数と、XPになったVCの時間（分）。期間ごとの発言数・VCのランキングと、連続日数に使う
  for (const column of ['message_count integer NOT NULL DEFAULT 0', 'voice_minutes integer NOT NULL DEFAULT 0']) {
    await pool.query(`ALTER TABLE level_daily_xp ADD COLUMN IF NOT EXISTS ${column}`);
  }
  // リアクションを「した」「もらった」回数（合計と日ごと）。日ごとの回数は、その日にXPをもらえる上限に使う
  for (const table of ['member_levels', 'level_daily_xp']) {
    for (const column of ['reactions_given integer NOT NULL DEFAULT 0', 'reactions_received integer NOT NULL DEFAULT 0']) {
      await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
    }
  }
  // XPにしたリアクション（同じ人が同じメッセージに付けたものは、絵文字を変えても1回だけ数えるため）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reaction_xp (
      guild_id   text        NOT NULL,
      message_id text        NOT NULL,
      user_id    text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, message_id, user_id)
    )
  `);
  // ランキング掲示板（1サーバーに1つ）。last_weekly_post はどの週（その週の月曜）、last_monthly_post はどの月（1日）の結果まで投稿したか
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_boards (
      guild_id         text PRIMARY KEY,
      channel_id       text NOT NULL,
      message_id       text NOT NULL,
      last_weekly_post date
    )
  `);
  await pool.query('ALTER TABLE ranking_boards ADD COLUMN IF NOT EXISTS last_monthly_post date');
  // 週・月が終わったときの結果（上位の人）。歴代記録と自己ベストに使う。ranking_periods はどの期間を記録し終えたか
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_periods (
      guild_id     text        NOT NULL,
      period       text        NOT NULL,
      period_start date        NOT NULL,
      recorded_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, period, period_start)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranking_results (
      guild_id     text    NOT NULL,
      period       text    NOT NULL,
      period_start date    NOT NULL,
      rank         integer NOT NULL,
      user_id      text    NOT NULL,
      xp           bigint  NOT NULL,
      PRIMARY KEY (guild_id, period, period_start, rank)
    )
  `);
  // サーバーごとの設定。xp_excluded_channel_ids はXPを入れないチャンネル（カテゴリーを選ぶと、その中のチャンネルも）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id                text        PRIMARY KEY,
      xp_excluded_channel_ids text[]      NOT NULL DEFAULT '{}',
      updated_at              timestamptz NOT NULL DEFAULT now()
    )
  `);
  // 誰の招待リンクで入ったか（招待ランキング用）。入り直しても、最初に連れてきた人のまま
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_invites (
      guild_id    text        NOT NULL,
      user_id     text        NOT NULL,
      inviter_id  text        NOT NULL,
      invite_code text        NOT NULL,
      joined_at   timestamptz NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // 入った人へのDMの案内。welcome_message は管理者が足す一言（空なら決まった文だけ）
  await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS welcome_enabled boolean NOT NULL DEFAULT true');
  await pool.query("ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS welcome_message text NOT NULL DEFAULT ''");
  // プロフィールの申請を、管理者の確認なしで自動で許可するか（最初はしない）
  await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS auto_approve boolean NOT NULL DEFAULT false');
  // 決めた日数来ていない人に「非アクティブ」ロールを付けるか（最初は付ける・14日）
  await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS inactive_role_enabled boolean NOT NULL DEFAULT true');
  await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS inactive_role_days smallint NOT NULL DEFAULT 14');
  // ハウジング抽選の日程。housing_anchor はある回の受付の終わり（＝結果発表の始まり）。そこから9日ごと（受付5日・結果発表4日）に繰り返す
  await pool.query('ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS housing_anchor timestamptz');
  // 申し込みメモ。results_at はその回の結果発表の始まり（そのときに、メモを残した人へ DM で知らせる）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS housing_entries (
      guild_id   text        NOT NULL,
      user_id    text        NOT NULL,
      results_at timestamptz NOT NULL,
      plot       text        NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id, results_at)
    )
  `);
  // 送ったお知らせ（同じお知らせを二重に送らないため）。kind は entry（受付）/ deadline（締め切り前）/ results（結果発表）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS housing_notices (
      guild_id text        NOT NULL,
      kind     text        NOT NULL,
      event_at timestamptz NOT NULL,
      sent_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, kind, event_at)
    )
  `);
  // 潜水艦の帰ってくる時間（1人4隻まで）。帰ってきたら DM で知らせて notified_at を付ける。
  // minutes は登録したときの帰ってくるまでの長さ（「同じ時間でもう一度」で使う）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS submarine_timers (
      guild_id    text        NOT NULL,
      user_id     text        NOT NULL,
      slot        smallint    NOT NULL,
      name        text        NOT NULL DEFAULT '',
      returns_at  timestamptz NOT NULL,
      minutes     integer     NOT NULL,
      notified_at timestamptz,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id, slot)
    )
  `);
  // 最後に来た日（発言・リアクション・VCに入った）。XPにならないもの（XPなしチャンネル・1人のVCなど）も含む。非アクティブの判定に使う
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_last_active (
      guild_id text NOT NULL,
      user_id  text NOT NULL,
      day      date NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    )
  `);
  // Botがメンバーごとに作った専用の招待リンク（Botが作るとリンクの作成者がBotになるので、誰のリンクかをここで覚える）。
  // retired_at は作り直したときに付ける（前のリンクで入った人も、持ち主に数える）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invite_links (
      guild_id   text        NOT NULL,
      code       text        NOT NULL,
      user_id    text        NOT NULL,
      channel_id text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      retired_at timestamptz,
      PRIMARY KEY (guild_id, code)
    )
  `);
  // 週1回の管理レポートを、どの週（その週の月曜）の分まで投稿したか
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_reports (
      guild_id   text        NOT NULL,
      week_start date        NOT NULL,
      posted_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, week_start)
    )
  `);
  // XPアップ期間（管理者が決めた期間だけ、もらえるXPを増やす）。percent は倍率（200 なら2倍）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS xp_boosts (
      id         bigserial   PRIMARY KEY,
      guild_id   text        NOT NULL,
      label      text        NOT NULL DEFAULT '',
      percent    integer     NOT NULL,
      starts_at  timestamptz NOT NULL,
      ends_at    timestamptz NOT NULL,
      created_by text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
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
