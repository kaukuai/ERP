import { today,addDays } from './core.mjs';

// Entirely fictional records for a separate demo database. Never used by normal startup.
export function seedDemo(erp) {
  if(erp.get('SELECT id FROM users LIMIT 1')) return erp.get("SELECT id,username,name,role,active FROM users WHERE username='demo'");
  const u=erp.setup({username:'demo',password:'Demo-only-'+crypto.randomUUID(),name:'體驗管理員',company:'成祥企業｜示範公司'});
  const sales=erp.saveUser(u,{username:'sales.demo',name:'陳怡安（示範）',password:'Demo-only-'+crypto.randomUUID(),role:'sales'});
  const salesUser=erp.get("SELECT id,username,name,role,active FROM users WHERE username='sales.demo'");
  erp.saveWarehouse(u,{code:'WH02',name:'台中轉運倉'});erp.saveWarehouse(u,{code:'WH03',name:'展示倉'});
  const partners=[
    ['C001','青禾生活有限公司','customer','林小姐','台北市（示範地址）'],
    ['C002','木森選物工作室','customer','張先生','新北市（示範地址）'],
    ['C003','日常百貨有限公司','customer','王小姐','台中市（示範地址）'],
    ['C004','向陽空間設計','customer','李先生','桃園市（示範地址）'],
    ['C005','好日子商行','customer','吳小姐','台南市（示範地址）'],
    ['V001','合豐製造有限公司','supplier','陳先生','彰化縣（示範地址）'],
    ['V002','永昇材料有限公司','supplier','蔡小姐','高雄市（示範地址）']
  ];
  partners.forEach(([code,name,kind,contact,address])=>erp.savePartner(u,{code,name,kind,contact,address,phone:'02-0000-0000',payment_days:30,credit_limit:kind==='customer'?'500000':'0',owner_id:kind==='customer'?salesUser.id:undefined,notes:'虛構示範資料'}));
  const rows=[
    ['PD-001','經典不鏽鋼保溫瓶','500ml・霧白','居家生活','支',480,260,30,186],
    ['PD-002','輕量隨行杯','350ml・岩灰','居家生活','個',350,180,40,128],
    ['PD-003','天然棉帆布提袋','M・原色','生活配件','只',220,95,50,28],
    ['PD-004','木質桌面收納盒','胡桃木・三格','辦公用品','個',680,380,15,64],
    ['PD-005','磁吸筆記本','A5・深綠','辦公用品','本',280,130,30,212],
    ['PD-006','極簡陶瓷馬克杯','400ml・奶茶','居家生活','個',390,185,25,16],
    ['PD-007','禮盒紙箱','雙入・牛皮','包裝材料','個',45,18,100,620],
    ['PD-008','禮盒緞帶','100cm・墨綠','包裝材料','條',15,4,100,840],
    ['PD-009','企業精選禮盒','保溫瓶＋筆記本','組合商品','組',850,412,10,0],
    ['PD-010','矽膠防滑杯墊','圓形・深灰','生活配件','片',90,28,40,246],
    ['PD-011','桌上型手機支架','鋁合金・銀','辦公用品','個',450,215,20,87],
    ['PD-012','環保餐具組','三件・原木','居家生活','組',320,145,30,98]
  ];
  for(const [sku,name,spec,category,unit,price,cost,safety,qty] of rows){const p=erp.saveProduct(u,{sku,name,spec,category,unit,price:String(price),cost:String(cost),safety_qty:String(safety),supplier_id:6,barcode:'DEMO'+sku.replace('-','')});if(qty)erp.adjust(u,{product_id:p.id,warehouse_id:1,qty:String(qty),unit_cost:String(cost),reason:'虛構示範期初庫存'});}
  erp.transfer(u,{product_id:1,from_id:1,to_id:2,qty:'25'});erp.transfer(u,{product_id:5,from_id:1,to_id:2,qty:'30'});
  erp.saveBOM(u,{product_id:9,name:'企業精選禮盒 BOM',lines:[{product_id:1,qty:'1'},{product_id:5,qty:'1'},{product_id:7,qty:'1'},{product_id:8,qty:'1'}]});
  erp.savePrice(u,{partner_id:1,product_id:1,price:'450'});
  const mk=(kind,partner,lines,notes,owner=salesUser)=>erp.saveDoc(kind==='purchase'?u:owner,{kind,partner_id:partner,warehouse_id:1,date:today(),due_date:addDays(today(),7),valid_until:addDays(today(),30),tax_mode:'exclusive',tax_bp:500,notes,lines:lines.map(([p,q,price])=>({product_id:p,qty:String(q),price:String(price)}))});
  const approve=d=>{erp.transition(u,d.id,'submit');return erp.transition(u,d.id,'approve');};
  const d1=approve(mk('order',1,[[1,24,450],[5,24,260]],'企業禮贈專案，請分箱包裝。'));erp.fulfil(u,d1.id,{lines:[{line_id:d1.lines[0].id,qty:'12'},{line_id:d1.lines[1].id,qty:'12'}]});
  const d2=approve(mk('order',2,[[2,18,350],[10,36,90]],'週五前到貨，送達前請先聯繫。'));erp.fulfil(u,d2.id,{});
  const item=erp.get("SELECT * FROM open_items WHERE kind='receivable' ORDER BY id DESC LIMIT 1");erp.pay(u,{open_item_id:item.id,amount:'3000',date:today(),method:'bank',reference:'示範部分收款'});
  erp.transition(salesUser,mk('order',3,[[4,8,680],[11,12,450]],'門市陳列補貨。').id,'submit');
  mk('order',4,[[6,10,390],[12,15,320]],'確認設計專案數量後送審。');
  approve(mk('quote',5,[[1,50,460],[3,50,210]],'報價有效 30 天；交期於訂單確認後另議。'));
  const po=approve(mk('purchase',6,[[3,100,95],[6,80,185]],'常備品補貨。'));erp.fulfil(u,po.id,{lines:[{line_id:po.lines[0].id,qty:'40'},{line_id:po.lines[1].id,qty:'30'}]});
  mk('purchase',7,[[7,300,18],[8,500,4]],'禮盒包裝材料。',u);
  erp.createWork(u,{product_id:9,warehouse_id:1,qty:'10'});
  erp.activity(salesUser,{partner_id:1,title:'企業禮盒第二批交期確認',notes:'客戶希望分兩批到貨，業務將於明日確認配送時段。',next_date:addDays(today(),1)});
  erp.activity(salesUser,{partner_id:3,title:'門市補貨需求追蹤',notes:'已送出訂單，等待主管核准。',next_date:today()});
  erp.loan(u,{kind:'out',partner_id:4,product_id:11,warehouse_id:1,qty:'2',due_date:addDays(today(),14),notes:'示範：客戶樣品借用'});
  erp.log(u,'demo_seed','system',1,{fictional:true});return u;
}
