import type { Pool } from "pg";

export interface StoredTelegramSettings {
  secretRef: string | null;
  authorizedChatIds: ReadonlyArray<string>;
  authorizedUserIds: ReadonlyArray<string>;
  updatedBy: string;
  updatedAt: Date;
}

export interface TelegramSettingsCommand {
  secretRef: string;
  authorizedChatIds: ReadonlyArray<string>;
  authorizedUserIds: ReadonlyArray<string>;
}

// References only -- the actual bot token lives in TELEGRAM_BOT_TOKEN (env)
// and is never written here or returned to the browser. Singleton row
// (migrations/0010_control_api.sql: id boolean PRIMARY KEY CHECK(id)).
export class PostgresTelegramSettingsStore {
  constructor(private readonly pool: Pool) {}

  async get(): Promise<StoredTelegramSettings> {
    const result = await this.pool.query<{
      secret_ref: string | null;
      authorized_chat_ids: string[];
      authorized_user_ids: string[];
      updated_by: string;
      updated_at: Date;
    }>(
      "SELECT secret_ref, authorized_chat_ids, authorized_user_ids, updated_by, updated_at FROM telegram_settings WHERE id",
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("telegram settings row missing");
    return {
      secretRef: row.secret_ref,
      authorizedChatIds: row.authorized_chat_ids,
      authorizedUserIds: row.authorized_user_ids,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    };
  }

  async save(
    command: TelegramSettingsCommand,
    actorId: string,
  ): Promise<StoredTelegramSettings> {
    if (!/^secret:\/\/[a-zA-Z0-9/_-]+$/.test(command.secretRef))
      throw new Error("invalid telegram secret reference");
    if (
      !command.authorizedChatIds.every((value) => /^-?[0-9]+$/.test(value)) ||
      !command.authorizedUserIds.every((value) => /^[0-9]+$/.test(value))
    )
      throw new Error("invalid telegram authorized identity");
    await this.pool.query(
      "UPDATE telegram_settings SET secret_ref=$1, authorized_chat_ids=$2, authorized_user_ids=$3, updated_by=$4, updated_at=CURRENT_TIMESTAMP WHERE id",
      [
        command.secretRef,
        command.authorizedChatIds,
        command.authorizedUserIds,
        actorId,
      ],
    );
    return this.get();
  }
}
