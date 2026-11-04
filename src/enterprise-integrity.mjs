export function enterpriseIntegrity(e) {
  const problems = [],
    balance = (code) =>
      e.get(
        "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
        code,
      ).n;
  const bin = e.all(
    "SELECT s.product_id,s.warehouse_id,s.qty,COALESCE((SELECT sum(bb.qty) FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE b.warehouse_id=s.warehouse_id AND bb.product_id=s.product_id),0) bin_qty FROM stocks s JOIN warehouse_controls c ON c.warehouse_id=s.warehouse_id AND c.enabled=1 WHERE s.qty<>COALESCE((SELECT sum(bb.qty) FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE b.warehouse_id=s.warehouse_id AND bb.product_id=s.product_id),0)",
  );
  if (bin.length) problems.push({ type: "bin_warehouse", rows: bin });
  const binLedger = e.all(
    "SELECT bb.id,bb.qty,COALESCE(sum(m.qty),0) ledger_qty FROM bin_balances bb LEFT JOIN bin_moves m ON m.bin_id=bb.bin_id AND m.product_id=bb.product_id AND m.lot_code=bb.lot_code GROUP BY bb.id HAVING bb.qty<>COALESCE(sum(m.qty),0)",
  );
  if (binLedger.length) problems.push({ type: "bin_ledger", rows: binLedger });
  const over = e.all(
    "SELECT bb.id,bb.qty,sum(r.qty) reserved FROM bin_balances bb JOIN bin_reservations r ON r.balance_id=bb.id JOIN warehouse_wave_lines l ON l.id=r.wave_line_id JOIN warehouse_waves w ON w.id=l.wave_id WHERE w.status='draft' GROUP BY bb.id HAVING sum(r.qty)>bb.qty",
  );
  if (over.length) problems.push({ type: "bin_reserved", rows: over });
  const ledgers = [
    [
      "foreign_receivable",
      balance("1102"),
      e.get(
        "SELECT COALESCE(sum(book_value),0) n FROM foreign_accounts WHERE kind='receivable' AND status='posted'",
      ).n,
    ],
    [
      "foreign_payable",
      -balance("2002"),
      e.get(
        "SELECT COALESCE(sum(book_value),0) n FROM foreign_accounts WHERE kind='payable' AND status='posted'",
      ).n,
    ],
    [
      "payroll_payable",
      -balance("2502"),
      e.get(
        "SELECT COALESCE(sum(l.net_pay-l.paid),0) n FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE r.status='posted'",
      ).n,
    ],
    [
      "production_wip",
      balance("1402"),
      e.get(
        "SELECT COALESCE(sum(cost),0) n FROM production_jobs WHERE status='released'",
      ).n,
    ],
  ];
  for (const [code, expression] of [
    ["2503", "l.tax"],
    [
      "2504",
      "l.labor_employee+l.health_employee+l.labor_employer+l.health_employer",
    ],
    ["2505", "l.pension_employee+l.pension_employer"],
    ["2506", "l.other_deduction"],
  ])
    ledgers.push([
      "payroll_" + code,
      -balance(code),
      e.get(
        "SELECT COALESCE(sum(" +
          expression +
          "),0) n FROM payroll_lines l JOIN payroll_runs r ON r.id=l.run_id WHERE r.status='posted'",
      ).n -
        e.get(
          "SELECT COALESCE(sum(amount),0) n FROM payroll_remittances WHERE account=? AND status='posted'",
          code,
        ).n,
    ]);
  for (const [type, ledger, subsidiary] of ledgers)
    if (ledger !== subsidiary) problems.push({ type, ledger, subsidiary });
  return problems;
}
