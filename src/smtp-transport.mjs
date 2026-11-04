import tls from "node:tls";
import net from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { email } from "./document-delivery.mjs";
const encoded = (s) => "=?UTF-8?B?" + Buffer.from(s).toString("base64") + "?=";
export function mailMessage(m) {
  email(m.from);
  email(m.to);
  if (/[\r\n]/.test(m.subject) || !/^[-a-zA-Z0-9@.]+$/.test(m.message_id))
    throw Error("郵件標頭錯誤");
  const boundary = "ERP_" + randomBytes(16).toString("hex"),
    ls = [
      `From: ${encoded(m.display_name)} <${m.from}>`,
      `To: <${m.to}>`,
      `Subject: ${encoded(m.subject)}`,
      `Message-ID: <${m.message_id}>`,
      `Date: ${new Date().toUTCString()}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(m.text)
        .toString("base64")
        .match(/.{1,76}/g)
        ?.join("\r\n") || "",
    ];
  for (const a of m.attachments)
    ls.push(
      `--${boundary}`,
      `Content-Type: ${a.type}`,
      `Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      "Content-Transfer-Encoding: base64",
      "",
      a.base64.match(/.{1,76}/g)?.join("\r\n") || "",
    );
  ls.push(`--${boundary}--`, "");
  return ls.join("\r\n");
}
export async function smtpSend(
  message,
  env = process.env,
  connectors = {
    tls: (options) => tls.connect(options),
    plain: (options) => net.connect(options),
  },
) {
  const host = env.ERP_MAIL_HOST,
    port = Number(env.ERP_MAIL_PORT || 465),
    mode = env.ERP_MAIL_TLS || "implicit";
  if (
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !["implicit", "starttls"].includes(mode)
  )
    throw Error("SMTP 設定不完整");
  let socket,
    uncertain = false;
  try {
    socket =
      mode === "implicit"
        ? connectors.tls({
            host,
            port,
            servername: host,
            rejectUnauthorized: true,
          })
        : connectors.plain({ host, port });
    socket.setTimeout(20000, () => socket.destroy(Error("SMTP timeout")));
    await once(socket, mode === "implicit" ? "secureConnect" : "connect");
    let buffer = "",
      pending = null;
    const ondata = (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 65536) {
        socket.destroy(Error("SMTP response too large"));
        return;
      }
      drain();
    };
    function drain() {
      if (!pending) return;
      const lines = buffer.split("\r\n");
      let end = -1;
      for (let i = 0; i < lines.length - 1; i++)
        if (/^\d{3} /.test(lines[i])) {
          end = i;
          break;
        }
      if (end < 0) return;
      const response = lines.slice(0, end + 1).join("\r\n");
      buffer = lines.slice(end + 1).join("\r\n");
      const p = pending;
      pending = null;
      p.resolve(response);
    }
    function read() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        drain();
      });
    }
    const onerror = (e) => {
      if (pending) {
        const p = pending;
        pending = null;
        p.reject(e);
      }
    };
    socket.on("data", ondata);
    socket.on("error", onerror);
    socket.on("close", () => onerror(Error("SMTP closed")));
    const expect = async (p, codes) => {
      const r = await p;
      if (!codes.includes(Number(r.slice(0, 3))))
        throw Error("SMTP rejected command");
      return r;
    };
    const command = (s, codes = [250]) => {
      const p = read();
      socket.write(s + "\r\n");
      return expect(p, codes);
    };
    await expect(read(), [220]);
    let hello = await command("EHLO erp.local");
    if (mode === "starttls") {
      if (!/STARTTLS/i.test(hello)) throw Error("SMTP requires STARTTLS");
      await command("STARTTLS", [220]);
      socket.off("data", ondata);
      socket.off("error", onerror);
      const plain = socket;
      socket = tls.connect({
        socket: plain,
        servername: host,
        rejectUnauthorized: true,
      });
      socket.setTimeout(20000, () => socket.destroy(Error("SMTP timeout")));
      await once(socket, "secureConnect");
      socket.on("data", ondata);
      socket.on("error", onerror);
      socket.on("close", () => onerror(Error("SMTP closed")));
      hello = await command("EHLO erp.local");
    }
    if (env.ERP_MAIL_USER) {
      if (!/AUTH.*PLAIN/i.test(hello))
        throw Error("SMTP AUTH PLAIN unavailable");
      await command(
        "AUTH PLAIN " +
          Buffer.from(
            "\0" + env.ERP_MAIL_USER + "\0" + (env.ERP_MAIL_PASSWORD || ""),
          ).toString("base64"),
        [235],
      );
    }
    await command("MAIL FROM:<" + email(message.from) + ">");
    await command("RCPT TO:<" + email(message.to) + ">", [250, 251]);
    await command("DATA", [354]);
    const accepted = read();
    uncertain = true;
    socket.write(mailMessage(message).replace(/^\./gm, "..") + "\r\n.\r\n");
    await expect(accepted, [250]);
    uncertain = false;
    socket.end("QUIT\r\n");
  } catch (error) {
    error.deliveryUncertain = uncertain;
    throw error;
  } finally {
    socket?.destroy();
  }
}
