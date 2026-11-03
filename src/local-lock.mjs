import { DatabaseSync } from 'node:sqlite';
import { join,dirname,basename } from 'node:path';

// An OS-managed SQLite lock needs no stale PID/file deletion after a crash.
// It protects this root database even when another launcher chooses a new port.
export function acquireLocalLock(database){
  if(database===':memory:')throw Error('本機服務必須使用檔案資料庫');
  let lock;
  try{lock=new DatabaseSync(join(dirname(database),'.'+basename(database)+'.local-service.lock.sqlite'));lock.exec('PRAGMA busy_timeout=0;CREATE TABLE IF NOT EXISTS service_lock(id INTEGER PRIMARY KEY);BEGIN EXCLUSIVE;');}
  catch(error){lock?.close();throw Error('無法取得本機資料鎖；可能已有服務正在啟動、執行或備份。請先關閉既有服務。'+error.message);}
  return ()=>{if(lock){lock.close();lock=null;}};
}
