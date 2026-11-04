import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ERP } from "../src/core.mjs";
import { Companies } from "../src/companies.mjs";
import { processDelivery } from "../src/document-delivery.mjs";
import { smtpSend } from "../src/smtp-transport.mjs";
export async function deliveryBatch(database, transport = smtpSend) {
  const e = new ERP(database),
    companies = new Companies(e, database);
  try {
    let processed = 0;
    for (const row of companies.list()) {
      const company = companies.resolve(row.slug).erp;
      const prefix =
          "ERP_MAIL_" + row.slug.replaceAll("-", "_").toUpperCase() + "_",
        env = { ...process.env };
      for (const key of ["HOST", "PORT", "TLS", "USER", "PASSWORD"])
        if (process.env[prefix + key] !== undefined)
          env["ERP_MAIL_" + key] = process.env[prefix + key];
      for (let n = 0; n < 20; n++) {
        if (!(await processDelivery(company, (m) => transport(m, env)))) break;
        processed++;
      }
    }
    return { processed };
  } finally {
    companies.close();
    e.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.env.VERCEL === "1" || process.env.ERP_MODE === "demo")
      throw Error("展示環境不可執行正式寄送");
    const arg = process.argv.indexOf("--db");
    if (arg < 0 || !process.argv[arg + 1])
      throw Error("請指定 --db 完整帳套資料庫路徑");
    const db = resolve(process.argv[arg + 1]);
    const { existsSync } = await import("node:fs");
    if (!existsSync(db)) throw Error("指定資料庫不存在，不建立空庫");
    console.log(JSON.stringify(await deliveryBatch(db)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
