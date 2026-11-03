import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import {
  resolve,
  join,
  dirname,
  basename,
  relative,
  isAbsolute,
} from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ERP } from "../src/core.mjs";
import { localHome } from "./local.mjs";
const execute = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
function contained(base, path) {
  const rel = relative(base, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel);
}
export function verifyBackup(manifestFile) {
  const folder = dirname(resolve(manifestFile)),
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (
    manifest.format !== "erp-scheduled-backup-v1" ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > 100
  )
    throw Error("備份清單格式不符");
  const scratch = mkdtempSync(join(tmpdir(), "erp-backup-drill-"));
  try {
    for (const entry of manifest.files) {
      if (
        !/^(company|demo)\.sqlite$|^\.company-workspaces\/company-[0-9a-f-]{36}\.sqlite$/.test(
          entry.path,
        ) ||
        !contained(folder, resolve(folder, entry.path))
      )
        throw Error("備份清單含不允許路徑");
      const file = resolve(folder, entry.path);
      if (!existsSync(file) || hash(file) !== entry.sha256)
        throw Error("備份雜湊不符或缺少檔案");
      const target = join(scratch, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      const e = new ERP(target);
      try {
        const check = e.integrity({ role: "admin" });
        if (!check.ok) throw Error("還原副本未通過庫存、帳務或總帳檢查");
      } finally {
        e.close();
      }
    }
    const rootEntry = manifest.files.find((x) =>
      /^(company|demo)\.sqlite$/.test(x.path),
    );
    if (!rootEntry) throw Error("缺少根帳套");
    const db = new DatabaseSync(join(scratch, rootEntry.path), {
      readOnly: true,
    });
    try {
      for (const c of db.prepare("SELECT filename FROM company_catalog").all())
        if (
          !manifest.files.some(
            (f) => f.path === ".company-workspaces/" + c.filename,
          )
        )
          throw Error("備份缺少關聯帳套");
    } finally {
      db.close();
    }
    return {
      verified: true,
      databases: manifest.files.length,
      checked_on_copies: true,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
export async function scheduledBackup({
  demo = false,
  retain = 30,
  destination,
} = {}) {
  if (!Number.isInteger(retain) || retain < 2 || retain > 365)
    throw Error("留存組數需為 2–365");
  const home = localHome(),
    configFile = join(home, demo ? "demo.json" : "company.json");
  if (!existsSync(configFile))
    throw Error("尚未初始化本機 ERP，沒有可備份的設定");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (
    config.format !== 1 ||
    config.initialized !== true ||
    !isAbsolute(config.dataDir)
  )
    throw Error("本機資料位置設定不正確");
  const database = join(
    config.dataDir,
    demo ? "demo.sqlite" : "company.sqlite",
  );
  if (!existsSync(database)) throw Error("找不到原資料庫，不會建立空庫替代");
  const directory = join(config.dataDir, "backups", "scheduled"),
    group = join(
      directory,
      new Date().toISOString().replaceAll(":", "-") + "-" + randomUUID(),
    );
  mkdirSync(group, { recursive: true });
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.toUpperCase().startsWith("ERP_") &&
        !["PORT", "NODE_TEST_CONTEXT"].includes(k.toUpperCase()),
    ),
  );
  try {
    const result = await execute(
        process.execPath,
        [
          join(root, "scripts/pre-upgrade.mjs"),
          "--db",
          database,
          "--all-companies",
        ],
        { env: childEnv, maxBuffer: 8 * 1024 * 1024 },
      ),
      report = JSON.parse(result.stdout),
      databases = report.databases || [report],
      files = [];
    for (let i = 0; i < databases.length; i++) {
      const item = databases[i],
        path =
          i === 0
            ? basename(database)
            : ".company-workspaces/" + basename(item.source),
        target = join(group, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(item.backup, target);
      files.push({ path, sha256: hash(target) });
    }
    const manifest = {
      format: "erp-scheduled-backup-v1",
      created_at: new Date().toISOString(),
      files,
    };
    const manifestFile = join(group, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const validation = verifyBackup(manifestFile);
    if (destination) {
      const targetRoot = resolve(destination);
      if (
        targetRoot === resolve(config.dataDir) ||
        contained(resolve(config.dataDir), targetRoot) ||
        contained(targetRoot, resolve(config.dataDir))
      )
        throw Error("異地備份目的地不可涵蓋或放在原資料目錄");
      const namespace = join(
          targetRoot,
          "erp-" +
            createHash("sha256")
              .update(realpathSync(database))
              .digest("hex")
              .slice(0, 16),
        ),
        target = join(namespace, basename(group));
      mkdirSync(target, { recursive: true });
      for (const entry of files) {
        const file = join(target, entry.path);
        mkdirSync(dirname(file), { recursive: true });
        copyFileSync(join(group, entry.path), file);
      }
      copyFileSync(manifestFile, join(target, "manifest.json"));
      verifyBackup(join(target, "manifest.json"));
    }
    for (const item of databases) {
      const original = resolve(item.backup),
        expected = resolve(dirname(item.source), "backups");
      if (
        contained(expected, original) &&
        basename(original).startsWith(basename(item.source) + "-before-v04-") &&
        original.endsWith(".sqlite") &&
        hash(original) ===
          files.find((f) => basename(f.path) === basename(item.source))?.sha256
      ) {
        rmSync(original);
        if (existsSync(original + ".json")) rmSync(original + ".json");
      }
    }
    // Rotate only validated groups created by this worker. Other/manual/upgrade backups are retained.
    const groups = readdirSync(directory, { withFileTypes: true })
      .filter((x) => x.isDirectory() && !x.isSymbolicLink())
      .map((x) => join(directory, x.name))
      .filter((x) => existsSync(join(x, "manifest.json")))
      .sort()
      .reverse();
    for (const old of groups.slice(retain)) {
      try {
        verifyBackup(join(old, "manifest.json"));
        if (contained(directory, old) && realpathSync(old) === resolve(old))
          rmSync(old, { recursive: true });
      } catch {}
    }
    return {
      manifest: manifestFile,
      ...validation,
      offsite_copied: !!destination,
      retained: Math.min(groups.length, retain),
    };
  } catch (error) {
    writeFileSync(join(group, "FAILED.txt"), "備份未完成：" + error.message);
    throw error;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--verify") {
      if (args.length !== 2) throw Error("用法：--verify MANIFEST");
      console.log(JSON.stringify(verifyBackup(args[1])));
    } else {
      let retain = 30,
        destination,
        demo = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--retain") retain = Number(args[++i]);
        else if (args[i] === "--destination") destination = args[++i];
        else if (args[i] === "--demo") demo = true;
        else throw Error("未知參數");
      }
      console.log(
        JSON.stringify(await scheduledBackup({ retain, destination, demo })),
      );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
