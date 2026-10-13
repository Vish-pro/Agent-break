// Admin CLI. Run on the server: `npm run cli -- <command>`.
// Use `remove-device` if a phone is lost: it frees the slot so a new phone can enroll.
import { openDb } from './db.ts';

const dataDir = process.env.DATA_DIR ?? './data';
const db = openDb(dataDir);
const [cmd, arg] = process.argv.slice(2);

switch (cmd) {
  case 'list-devices': {
    const rows = db.prepare('SELECT id, name, created_at, push_token IS NOT NULL AS push FROM devices').all();
    console.table(rows);
    break;
  }
  case 'remove-device': {
    if (!arg) throw new Error('usage: remove-device <deviceId>');
    const { changes } = db.prepare('DELETE FROM devices WHERE id = ?').run(arg);
    console.log(changes ? `removed ${arg} (restart server to drop live connection)` : 'no such device');
    break;
  }
  case 'stats': {
    console.log(db.prepare('SELECT (SELECT COUNT(*) FROM messages) AS pending_messages, (SELECT COUNT(*) FROM blobs) AS blobs').get());
    break;
  }
  default:
    console.log('commands: list-devices | remove-device <id> | stats');
}
db.close();
