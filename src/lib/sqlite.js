export const SECURE_DELETE_PRAGMA = "PRAGMA secure_delete = ON";

export const enableSecureDelete = (db) => {
  db.exec(SECURE_DELETE_PRAGMA);
};
