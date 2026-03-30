import { SQLite, selectQuery, upsertQuery } from "@hocuspocus/extension-sqlite";
import * as Y from "yjs";
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

  async onDestroy() {
    if (!this.db) return;

    const db = this.db;
    this.db = null;

    await new Promise((resolve, reject) => {
      db.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  // The upstream sqlite extension schedules sqlite3 work but does not await
  // the callback completion. We need the real write to finish before backup hooks run.
  async onLoadDocument({ document, documentName }) {
    if (!this.db) {
      throw new Error("SQLite database is not configured");
    }

    const update = await new Promise((resolve, reject) => {
      this.db.get(selectQuery, { $name: documentName }, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(row?.data ?? null);
      });
    });

    if (update) {
      Y.applyUpdate(document, update);
    }
  }

  async onStoreDocument({ document, documentName }) {
    if (!this.db) {
      throw new Error("SQLite database is not configured");
    }

    const state = Buffer.from(Y.encodeStateAsUpdate(document));

    await new Promise((resolve, reject) => {
      this.db.run(upsertQuery, {
        $name: documentName,
        $data: state,
      }, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
