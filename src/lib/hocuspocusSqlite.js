import { SQLite } from "@hocuspocus/extension-sqlite";
import { SECURE_DELETE_PRAGMA } from "./sqlite.js";

export class FocusCompassSQLite extends SQLite {
  async onConfigure() {
    await super.onConfigure();
    if (!this.db) return;

    await new Promise((resolve, reject) => {
      this.db.exec(SECURE_DELETE_PRAGMA, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
