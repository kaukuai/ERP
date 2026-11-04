import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { smtpSend } from "../src/smtp-transport.mjs";
async function smtpFixture(t, uncertain = false) {
  let received = "",
    commands = [],
    tlsOptions;
  const sockets = new Set(),
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.write("220 test SMTP\r\n");
      let buffer = "",
        data = false;
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          received = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          data = false;
          if (uncertain) socket.destroy();
          else socket.write("250 accepted\r\n");
          return;
        }
        let at;
        while ((at = buffer.indexOf("\r\n")) >= 0) {
          const command = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          commands.push(command);
          if (command.startsWith("EHLO"))
            socket.write("250-test.example\r\n250 AUTH PLAIN\r\n");
          else if (command.startsWith("AUTH")) socket.write("235 ok\r\n");
          else if (command === "DATA") {
            data = true;
            socket.write("354 send\r\n");
            break;
          } else socket.write("250 ok\r\n");
        }
      });
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const connectors = {
    tls: (options) => {
      tlsOptions = options;
      const socket = net.connect({ host: options.host, port: options.port });
      socket.once("connect", () => socket.emit("secureConnect"));
      return socket;
    },
    plain: () => assert.fail("implicit TLS expected"),
  };
  return {
    env: {
      ERP_MAIL_HOST: "127.0.0.1",
      ERP_MAIL_PORT: String(server.address().port),
      ERP_MAIL_USER: "fake-user",
      ERP_MAIL_PASSWORD: "fake-test-only",
    },
    connectors,
    received: () => received,
    commands: () => commands,
    tlsOptions: () => tlsOptions,
  };
}
const message = {
  from: "sender@example.invalid",
  to: "recipient@example.invalid",
  display_name: "測試寄件人",
  subject: "測試主旨",
  text: "測試內容",
  message_id: "test-123@erp.local",
  attachments: [
    {
      name: "訂單.html",
      type: "text/html",
      base64: Buffer.from("<h1>訂單</h1>").toString("base64"),
    },
  ],
};
test("SMTP transport writes real envelope, TLS verification options, UTF-8 MIME and attachment data to an isolated mock server", async (t) => {
  const f = await smtpFixture(t);
  await smtpSend(message, f.env, f.connectors);
  assert.equal(f.tlsOptions().rejectUnauthorized, true);
  assert.equal(f.tlsOptions().servername, "127.0.0.1");
  assert.ok(f.commands().includes("MAIL FROM:<sender@example.invalid>"));
  assert.ok(f.commands().includes("RCPT TO:<recipient@example.invalid>"));
  assert.match(f.received(), /Subject: =\?UTF-8\?B\?/);
  assert.match(f.received(), /Content-Disposition: attachment/);
  assert.match(f.received(), new RegExp(message.attachments[0].base64));
});
test("SMTP connection loss after DATA is marked uncertain and never reported as successful acceptance", async (t) => {
  const f = await smtpFixture(t, true);
  await assert.rejects(
    smtpSend(message, f.env, f.connectors),
    (e) => e.deliveryUncertain === true,
  );
});
