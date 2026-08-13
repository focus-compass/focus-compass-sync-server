import { SQLite } from "@hocuspocus/extension-sqlite";
import { SECURE_DELETE_PRAGMA } from "./sqlite.js";

export class FocusCompassSQLite extends SQLite {
  async onConfigure() {
    await super.onConfigure();
    if (!this.db) return;

    // Hocuspocus 4 uses better-sqlite3, whose API is synchronous. The database
    // file and schema are unchanged from v3; only the driver API differs.
    this.db.exec(SECURE_DELETE_PRAGMA);
  }

  async onDestroy() {
    if (!this.db) return;

    const db = this.db;
    this.db = undefined;
    db.close();
  }
}
