import { createHash, randomUUID } from "node:crypto";
import { Forms } from "./forms.mjs";
import { fail, integer, txt, now } from "./core.mjs";
import { accessContext } from "./access-control.mjs";
import {
  enterprisePermission as permission,
  enterpriseRows as rows,
  revision,
  event,
} from "./enterprise-common.mjs";
const resource = "document_outbox";
export function email(value) {
  const v = txt(value, 254, true);
  if (
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(
      v,
    ) ||
    /[\r\n]/.test(v)
  )
    fail("電子郵件格式錯誤");
  return v;
}
function locale(v) {
  const s = txt(v, 35);
  if (s && !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(s))
    fail("語系請用 zh-TW、en 等標記");
  return s.toLowerCase();
}
export class DocumentDelivery {
  constructor(e, { disabled = false } = {}) {
    this.e = e;
    this.forms = new Forms(e);
    this.disabled = disabled;
  }
  configure(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const old = JSON.parse(this.e.settings().mail_policy || '{"version":0}');
      if (old.version !== integer(b.version ?? 0)) fail("寄件設定已變更", 409);
      const policy = {
        version: old.version + 1,
        enabled: b.enabled === true,
        from: email(b.from),
        display_name: txt(b.display_name, 80, true),
      };
      if (/[\r\n]/.test(policy.display_name)) fail("寄件名稱不可換行");
      this.e.run(
        "INSERT INTO settings(key,value) VALUES('mail_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        JSON.stringify(policy),
      );
      event(this.e, u, "mail_policy", 0, "save", {
        before: old,
        after: policy,
      });
      return policy;
    });
  }
  defaults(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const kind = b.kind;
      if (!["quote", "order", "purchase"].includes(kind))
        fail("預設版型來源錯誤");
      const partner = b.partner_id ? this.e.partner(u, b.partner_id) : null,
        t = this.forms.template(u, b.template_id, "print");
      if (t.kind !== kind || !t.active) fail("預設版型須啟用且符合來源類型");
      const lang = locale(b.locale),
        old = this.e.get(
          "SELECT * FROM document_defaults WHERE kind=? AND COALESCE(partner_id,0)=? AND locale=?",
          kind,
          partner?.id || 0,
          lang,
        );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("預設版型已變更", 409);
      this.e.run(
        "INSERT INTO document_defaults(kind,partner_id,locale,template_id,created_by) VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET template_id=excluded.template_id,version=version+1,created_by=excluded.created_by",
        kind,
        partner?.id || null,
        lang,
        t.id,
        u.id,
      );
      event(this.e, u, "document_defaults", 0, "save", {
        kind,
        partner_id: partner?.id || null,
        locale: lang,
        template_id: t.id,
      });
      if (partner && lang && b.set_partner_language === true)
        this.e.run(
          "INSERT INTO partner_document_preferences(partner_id,locale) VALUES(?,?) ON CONFLICT(partner_id) DO UPDATE SET locale=excluded.locale,version=version+1",
          partner.id,
          lang,
        );
      return { ok: true };
    });
  }
  resolve(u, documentId, lang = "") {
    const d = this.e.doc(u, documentId),
      l = locale(
        lang ||
          this.e.get(
            "SELECT locale FROM partner_document_preferences WHERE partner_id=?",
            d.partner_id,
          )?.locale ||
          "zh-TW",
      ),
      candidates = this.e.all(
        "SELECT * FROM document_defaults WHERE kind=? AND (partner_id=? OR partner_id IS NULL) AND locale IN (?,'') ORDER BY CASE WHEN partner_id IS NOT NULL THEN 0 ELSE 1 END,CASE WHEN locale<>'' THEN 0 ELSE 1 END,id",
        d.kind,
        d.partner_id,
        l,
      );
    for (const c of candidates) {
      try {
        const t = this.forms.template(u, c.template_id, "print");
        if (t.active && t.kind === d.kind) {
          this.forms.document(u, d.id, d.kind);
          return {
            template_id: t.id,
            template_version: t.version,
            locale: l,
            rule_id: c.id,
          };
        }
      } catch (error) {
        if (error.status !== 403 && error.status !== 404) throw error;
      }
    }
    return { template_id: null, locale: l };
  }
  queue(u, b) {
    permission(this.e, u, resource, "create");
    permission(this.e, u, resource, "post");
    return this.e.tx(() => {
      let html,
        sourceVersion,
        templateVersion,
        template = null,
        doc = null,
        entry = null;
      if (b.document_id) {
        doc = this.e.doc(u, b.document_id);
        if (
          !["approved", "partial", "completed", "closed", "converted"].includes(
            doc.status,
          )
        )
          fail("請先核准來源單據再寄送");
        template = this.forms.template(
          u,
          b.template_id || this.resolve(u, doc.id, b.locale).template_id,
          "print",
        );
        if (!template.active) fail("版型已停用");
        html = this.forms.printTemplate(u, template.id, {
          document_id: doc.id,
        });
        sourceVersion = doc.version;
        templateVersion = template.version;
      } else {
        entry = this.forms.entry(u, integer(b.entry_id, 1), "print");
        if (entry.status !== "submitted") fail("請先送出表單再寄送");
        html = this.forms.printEntry(u, entry.id);
        sourceVersion = entry.version;
        templateVersion = entry.template_version;
      }
      const recipient = email(b.recipient),
        subject = txt(b.subject, 160, true);
      if (/[\r\n]/.test(subject)) fail("主旨不可換行");
      const attachments = [
        {
          name: (doc?.no || entry.no) + ".html",
          type: "text/html",
          base64: Buffer.from(html).toString("base64"),
        },
      ];
      if (b.attachments !== undefined && !Array.isArray(b.attachments))
        fail("附件格式錯誤");
      if ((b.attachments || []).length > 4) fail("額外附件最多 4 個");
      for (const a of b.attachments || []) {
        const name = txt(a.name, 100, true);
        if (
          /[\r\n/\\\x00]/.test(name) ||
          ![
            "application/pdf",
            "image/png",
            "image/jpeg",
            "text/plain",
          ].includes(a.type) ||
          typeof a.base64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(a.base64)
        )
          fail("附件名稱、類型或編碼錯誤");
        const bytes = Buffer.from(a.base64, "base64");
        if (
          a.type === "application/pdf" &&
          !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
        )
          fail("PDF 附件內容不符");
        if (
          a.type === "image/png" &&
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          fail("PNG 附件內容不符");
        if (
          a.type === "image/jpeg" &&
          !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
        )
          fail("JPEG 附件內容不符");
        attachments.push({ name, type: a.type, base64: a.base64 });
      }
      if (
        attachments.reduce(
          (n, a) => n + Buffer.from(a.base64, "base64").length,
          0,
        ) >
        1024 * 1024
      )
        fail("含表單的附件總計需小於 1 MB");
      const policy = JSON.parse(this.e.settings().mail_policy || "{}");
      if (!this.disabled && !policy.enabled)
        fail("請先由管理員啟用並設定寄件服務");
      const payload = JSON.stringify({
          from: policy.from || "demo@example.invalid",
          display_name: policy.display_name || "ERP 展示",
          text: txt(b.text, 5000),
          attachments,
        }),
        messageId = randomUUID() + "@erp.local",
        id = Number(
          this.e.run(
            "INSERT INTO document_outbox(message_id,document_id,entry_id,template_id,source_version,template_version,locale,recipient,subject,payload,payload_hash,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            messageId,
            doc?.id || null,
            entry?.id || null,
            template?.id || entry?.template_id,
            sourceVersion,
            templateVersion,
            locale(b.locale),
            recipient,
            subject,
            payload,
            createHash("sha256").update(payload).digest("hex"),
            this.disabled ? "demo" : "queued",
            u.id,
            now(),
          ).lastInsertRowid,
        );
      permission(this.e, u, resource, "create", id);
      event(this.e, u, resource, id, "queue", {
        source_version: sourceVersion,
        template_version: templateVersion,
        demo: this.disabled,
      });
      return this.detail(u, id);
    });
  }
  authorize(u, r, action = "read") {
    permission(this.e, u, resource, action, r.id);
    if (r.document_id) {
      const doc = this.e.doc(u, r.document_id);
      this.forms.document(u, doc.id, doc.kind);
      this.forms.template(u, r.template_id, "print");
    } else this.forms.entry(u, r.entry_id, "print");
  }
  detail(u, id) {
    const r = this.e.get(
      "SELECT * FROM document_outbox WHERE id=?",
      integer(id, 1),
    );
    if (!r) fail("寄送工作不存在", 404);
    this.authorize(u, r);
    const p = JSON.parse(r.payload);
    return {
      ...r,
      payload: undefined,
      attachments: p.attachments.map((a) => ({
        name: a.name,
        type: a.type,
        bytes: Buffer.from(a.base64, "base64").length,
      })),
      text: p.text,
    };
  }
  action(u, b) {
    return this.e.tx(() => {
      const r = this.e.get(
        "SELECT * FROM document_outbox WHERE id=?",
        integer(b.id, 1),
      );
      if (!r) fail("寄送工作不存在", 404);
      this.authorize(u, r, b.action === "cancel" ? "cancel" : "post");
      revision(r, b);
      const reason = txt(b.reason, 500, true);
      let status;
      if (b.action === "cancel") {
        if (
          !["queued", "retry", "failed", "uncertain", "demo"].includes(r.status)
        )
          fail("寄送中或已寄出不能取消", 409);
        status = "cancelled";
      } else if (b.action === "retry") {
        if (!["failed", "uncertain"].includes(r.status))
          fail("此狀態不能重送", 409);
        if (r.status === "uncertain" && b.confirm_possible_duplicate !== true)
          fail("寄送結果不明，須先核對郵件服務並確認可能重複", 409);
        if (this.disabled) fail("展示版不會寄送");
        status = "queued";
      } else fail("寄送動作錯誤");
      this.e.run(
        "UPDATE document_outbox SET status=?,version=version+1,attempts=0,next_attempt=0,lease='' WHERE id=?",
        status,
        r.id,
      );
      event(this.e, u, resource, r.id, b.action, { reason });
      return this.detail(u, r.id);
    });
  }
  data(u) {
    permission(this.e, u, resource);
    const list = rows(this.e, u, resource)
      .filter((r) => {
        try {
          this.authorize(u, r);
          return true;
        } catch (error) {
          if ([403, 404].includes(error.status)) return false;
          throw error;
        }
      })
      .map(({ payload, ...r }) => r);
    return {
      outbox: list,
      defaults: rows(this.e, u, "document_defaults"),
      policy: this.e.access.policy(u).superuser
        ? JSON.parse(
            this.e.settings().mail_policy || '{"version":0,"enabled":false}',
          )
        : undefined,
      demo: this.disabled,
    };
  }
}
export async function processDelivery(e, transport) {
  const item = e.tx(() => {
    e.run(
      "UPDATE document_outbox SET status='uncertain',version=version+1,last_error='工作中斷，請先核對郵件服務是否已接受',lease='' WHERE status='sending' AND claimed_at<?",
      Date.now() - 10 * 60000,
    );
    const r = e.get(
      "SELECT * FROM document_outbox WHERE status IN ('queued','retry') AND next_attempt<=? ORDER BY id LIMIT 1",
      Date.now(),
    );
    if (!r) return null;
    const lease = randomUUID();
    e.run(
      "UPDATE document_outbox SET status='sending',lease=?,claimed_at=?,attempts=attempts+1,version=version+1 WHERE id=?",
      lease,
      Date.now(),
      r.id,
    );
    return { ...r, lease, attempts: r.attempts + 1 };
  });
  if (!item) return false;
  try {
    const u = e.user(item.created_by);
    if (!u.active) fail("原寄件使用者已停用", 403);
    const delivery = new DocumentDelivery(e);
    accessContext.run({ policy: e.access.policy(u), reading: true }, () => {
      delivery.authorize(u, item, "post");
      if (item.document_id) {
        const d = e.doc(u, item.document_id),
          t = delivery.forms.template(u, item.template_id, "print");
        if (
          d.version !== item.source_version ||
          t.version !== item.template_version ||
          !t.active
        )
          fail("來源或版型已更新，請取消並重新排程", 409);
      } else if (
        delivery.forms.entry(u, item.entry_id, "print").version !==
        item.source_version
      )
        fail("表單已更新，請重新排程", 409);
    });
    const policy = JSON.parse(e.settings().mail_policy || "{}");
    if (!policy.enabled) fail("寄件服務已停用", 409);
    const payload = JSON.parse(item.payload);
    if (
      createHash("sha256").update(item.payload).digest("hex") !==
      item.payload_hash
    )
      fail("寄件快照驗證失敗", 409);
    await transport({
      ...payload,
      to: item.recipient,
      subject: item.subject,
      message_id: item.message_id,
    });
    e.tx(() => {
      e.run(
        "UPDATE document_outbox SET status='sent',sent_at=?,version=version+1,lease='',last_error='' WHERE id=? AND lease=?",
        now(),
        item.id,
        item.lease,
      );
      event(e, { id: item.created_by }, resource, item.id, "sent", {
        message_id: item.message_id,
      });
    });
  } catch (error) {
    const status = error.deliveryUncertain
        ? "uncertain"
        : error.status || item.attempts >= 5
          ? "failed"
          : "retry",
      message = error.status
        ? String(error.message).slice(0, 300)
        : error.deliveryUncertain
          ? "郵件接受結果不明，請先核對郵件服務"
          : "寄送服務暫時失敗，請檢查伺服器設定或連線";
    e.tx(() => {
      e.run(
        "UPDATE document_outbox SET status=?,last_error=?,next_attempt=?,version=version+1,lease='' WHERE id=? AND lease=?",
        status,
        message,
        Date.now() + Math.min(3600000, 30000 * 2 ** item.attempts),
        item.id,
        item.lease,
      );
      event(e, { id: item.created_by }, resource, item.id, status, { message });
    });
  }
  return true;
}
