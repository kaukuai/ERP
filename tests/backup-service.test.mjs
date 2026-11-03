import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ERP } from "../src/core.mjs";
import { scheduledBackup, verifyBackup } from "../scripts/backup-service.mjs";
test("scheduled backups verify restoration, rotate only managed groups, copy another location and reject tampering", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "erp-scheduled-")),
    previous = process.env.ERP_LOCAL_HOME;
  process.env.ERP_LOCAL_HOME = scratch;
  t.after(() => {
    if (previous === undefined) delete process.env.ERP_LOCAL_HOME;
    else process.env.ERP_LOCAL_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  });
  const e = new ERP(join(scratch, "company.sqlite"));
  e.setup({ username: "admin", password: "backup-service-test-2026" });
  e.close();
  writeFileSync(
    join(scratch, "company.json"),
    JSON.stringify({ format: 1, initialized: true, dataDir: scratch }),
  );
  const destination = join(scratch + "-offsite");
  t.after(() => rmSync(destination, { recursive: true, force: true }));
  const one = await scheduledBackup({ retain: 2, destination });
  assert.equal(one.verified, true);
  assert.equal(one.offsite_copied, true);
  assert.equal(verifyBackup(one.manifest).databases, 1);
  await scheduledBackup({ retain: 2 });
  const three = await scheduledBackup({ retain: 2 });
  assert.equal(readdirSync(join(scratch, "backups", "scheduled")).length, 2);
  assert.equal(existsSync(one.manifest), false);
  appendFileSync(join(three.manifest, "..", "company.sqlite"), "corrupted");
  assert.throws(() => verifyBackup(three.manifest), /雜湊/);
  await assert.rejects(
    () => scheduledBackup({ retain: 2, destination: join(scratch, "copy") }),
    /目的地/,
  );
});
test("backup rotation accepts a canonical directory alias while preserving other folders", async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "erp-backup-alias-")),
    previous = process.env.ERP_LOCAL_HOME;
  process.env.ERP_LOCAL_HOME = scratch;
  t.after(() => {
    if (previous === undefined) delete process.env.ERP_LOCAL_HOME;
    else process.env.ERP_LOCAL_HOME = previous;
    rmSync(scratch, { recursive: true, force: true });
  });
  const physical = join(scratch, "physical"),
    alias = join(scratch, "alias"),
    e = new ERP(join(physical, "company.sqlite"));
  e.setup({ username: "admin", password: "backup-alias-test-2026" });
  e.close();
  symlinkSync(
    physical,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  writeFileSync(
    join(scratch, "company.json"),
    JSON.stringify({ format: 1, initialized: true, dataDir: alias }),
  );
  await scheduledBackup({ retain: 2 });
  await scheduledBackup({ retain: 2 });
  await scheduledBackup({ retain: 2 });
  assert.equal(readdirSync(join(physical, "backups", "scheduled")).length, 2);
  assert.equal(existsSync(join(physical, "company.sqlite")), true);
});
