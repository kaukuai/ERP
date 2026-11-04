export function migrateV17(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 17
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 CREATE TABLE quality_specs(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),direction TEXT NOT NULL CHECK(direction IN ('receipt','shipment')),name TEXT NOT NULL,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
 CREATE UNIQUE INDEX quality_active_spec ON quality_specs(product_id,direction) WHERE active=1;
 CREATE TABLE quality_inspections(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,document_id INTEGER NOT NULL REFERENCES documents(id),document_version INTEGER NOT NULL,selection_hash TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,released_by INTEGER REFERENCES users(id));
 CREATE TABLE quality_inspection_lines(id INTEGER PRIMARY KEY,inspection_id INTEGER NOT NULL REFERENCES quality_inspections(id),document_line_id INTEGER NOT NULL REFERENCES document_lines(id),product_id INTEGER NOT NULL REFERENCES products(id),qty INTEGER NOT NULL,base_qty INTEGER NOT NULL,spec_id INTEGER REFERENCES quality_specs(id),spec_version INTEGER,definition TEXT NOT NULL,required_sample_qty INTEGER NOT NULL,sampled_qty INTEGER NOT NULL DEFAULT 0,readings TEXT NOT NULL DEFAULT '{}',UNIQUE(inspection_id,document_line_id));
 CREATE TABLE quality_events(id INTEGER PRIMARY KEY,inspection_id INTEGER NOT NULL REFERENCES quality_inspections(id),action TEXT NOT NULL,detail TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE quality_releases(inspection_id INTEGER PRIMARY KEY REFERENCES quality_inspections(id),fulfilment_id INTEGER NOT NULL UNIQUE REFERENCES fulfilments(id),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE vendor_bills(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,supplier_id INTEGER NOT NULL REFERENCES partners(id),invoice_ref TEXT NOT NULL,date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,total INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,approved_by INTEGER REFERENCES users(id));
 CREATE UNIQUE INDEX vendor_bill_reference ON vendor_bills(supplier_id,invoice_ref) WHERE status<>'cancelled';
 CREATE TABLE vendor_bill_lines(id INTEGER PRIMARY KEY,bill_id INTEGER NOT NULL REFERENCES vendor_bills(id),receipt_line_id INTEGER NOT NULL REFERENCES fulfilment_lines(id),qty INTEGER NOT NULL,claimed_net INTEGER NOT NULL,claimed_tax INTEGER NOT NULL,UNIQUE(bill_id,receipt_line_id));
 CREATE TABLE vendor_bill_links(bill_id INTEGER NOT NULL REFERENCES vendor_bills(id),open_item_id INTEGER NOT NULL REFERENCES open_items(id),source_amount INTEGER NOT NULL,return_max INTEGER NOT NULL,allowance_max INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(bill_id,open_item_id));
 CREATE TABLE vendor_bill_events(id INTEGER PRIMARY KEY,bill_id INTEGER NOT NULL REFERENCES vendor_bills(id),action TEXT NOT NULL,detail TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 INSERT OR IGNORE INTO settings VALUES('procurement_control_policy','{"version":0,"require_matching":false,"quantity_tolerance_bp":0,"net_tolerance_bp":0,"tax_tolerance_cents":0,"forbid_self_approval":true}');
 CREATE TRIGGER require_vendor_match BEFORE UPDATE OF paid ON open_items WHEN NEW.kind='payable' AND NEW.paid>OLD.paid AND json_extract((SELECT value FROM settings WHERE key='procurement_control_policy'),'$.require_matching')=1 AND NOT EXISTS(
   SELECT 1 FROM vendor_bill_links l JOIN vendor_bills b ON b.id=l.bill_id WHERE l.open_item_id=OLD.id AND b.status='approved' AND l.source_amount=OLD.amount
   AND l.return_max=COALESCE((SELECT max(id) FROM returns WHERE fulfilment_id=OLD.fulfilment_id),0)
   AND l.allowance_max=COALESCE((SELECT max(id) FROM allowances WHERE fulfilment_id=OLD.fulfilment_id),0)
 ) BEGIN SELECT RAISE(ABORT,'ERP_VENDOR_MATCH_REQUIRED'); END;
 CREATE TRIGGER quality_snapshot BEFORE UPDATE OF document_id,document_version,selection_hash,direction,created_by,created_at ON quality_inspections BEGIN SELECT RAISE(ABORT,'immutable quality snapshot'); END;
 CREATE TRIGGER quality_line_snapshot BEFORE UPDATE OF inspection_id,document_line_id,product_id,qty,base_qty,spec_id,spec_version,definition,required_sample_qty ON quality_inspection_lines BEGIN SELECT RAISE(ABORT,'immutable quality line snapshot'); END;
 `);
    for (const table of [
      "quality_events",
      "quality_releases",
      "vendor_bill_links",
      "vendor_bill_events",
    ])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable control history'); END;`,
        );
    for (const action of ["INSERT", "UPDATE", "DELETE"]) {
      const row = action === "INSERT" ? "NEW" : "OLD";
      db.exec(
        `CREATE TRIGGER vendor_bill_line_${action.toLowerCase()} BEFORE ${action} ON vendor_bill_lines WHEN (SELECT status FROM vendor_bills WHERE id=${row}.bill_id)<>'draft' BEGIN SELECT RAISE(ABORT,'locked vendor bill'); END;`,
      );
    }
    db.exec(
      "CREATE TRIGGER quality_reading_lock BEFORE UPDATE OF sampled_qty,readings ON quality_inspection_lines WHEN (SELECT status FROM quality_inspections WHERE id=OLD.inspection_id)<>'draft' BEGIN SELECT RAISE(ABORT,'locked quality readings'); END;",
    );
    db.exec(`
      CREATE TRIGGER quality_line_no_delete BEFORE DELETE ON quality_inspection_lines BEGIN SELECT RAISE(ABORT,'immutable quality snapshot'); END;
      CREATE TRIGGER quality_line_insert_lock BEFORE INSERT ON quality_inspection_lines WHEN (SELECT status FROM quality_inspections WHERE id=NEW.inspection_id)<>'draft' BEGIN SELECT RAISE(ABORT,'locked quality readings'); END;
      CREATE TRIGGER vendor_bill_header_lock BEFORE UPDATE OF no,supplier_id,invoice_ref,date,total,notes,created_by,created_at ON vendor_bills WHEN OLD.status<>'draft' BEGIN SELECT RAISE(ABORT,'locked vendor bill'); END;
      CREATE TRIGGER vendor_bill_parent_lock BEFORE UPDATE OF bill_id ON vendor_bill_lines BEGIN SELECT RAISE(ABORT,'immutable vendor source'); END;
      CREATE INDEX quality_source_status ON quality_inspections(document_id,status);
      CREATE INDEX quality_event_lookup ON quality_events(inspection_id,id);
      CREATE INDEX vendor_receipt_lookup ON vendor_bill_lines(receipt_line_id,bill_id);
      CREATE INDEX vendor_link_lookup ON vendor_bill_links(open_item_id,bill_id);
      CREATE INDEX vendor_event_lookup ON vendor_bill_events(bill_id,id);
    `);
    db.prepare(
      "UPDATE settings SET value='17' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
