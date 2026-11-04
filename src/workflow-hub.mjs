import { Governance } from './governance.mjs';
import { Forms } from './forms.mjs';
import { OrderWorkflows } from './order-workflows.mjs';
import { SkuOrders } from './sku-orders.mjs';
import { CustomReports } from './custom-reports.mjs';
import { FinanceWorkflows } from './finance-workflows.mjs';
import { BillWorkflows } from './bill-workflows.mjs';
import { InventoryTracking } from './inventory-tracking.mjs';
import { InvoiceWorkflows } from './invoice-workflows.mjs';
import { ServiceWorkflows } from './service-workflows.mjs';
import { POS } from './pos.mjs';
import { MasterImports } from './master-imports.mjs';

export class WorkflowHub {
  constructor(e){this.governance=new Governance(e);this.forms=new Forms(e);this.orders=new OrderWorkflows(e);this.imports=new SkuOrders(e);this.reports=new CustomReports(e);this.finance=new FinanceWorkflows(e);this.bills=new BillWorkflows(e);this.inventory=new InventoryTracking(e);this.invoices=new InvoiceWorkflows(e);this.services=new ServiceWorkflows(e);this.pos=new POS(e);this.masters=new MasterImports(e);}
  data(u){return {...this.governance.data(u),...this.forms.data(u),...this.orders.data(u),...this.imports.data(u),...this.reports.data(u),...this.finance.data(u),...this.bills.data(u),...this.inventory.data(u),...this.invoices.data(u),...this.services.data(u),...this.pos.data(u),...this.masters.data(u)};}
  get(u,path,query){
    const gov=this.governance.get(u,path);if(gov!==undefined)return gov;
    const form=this.forms.get(u,path);if(form!==undefined)return form;
    const id=path.split('/')[3];
    if(/^\/api\/expense-allocations\/\d+$/.test(path))return this.finance.allocation(u,id);
    if(/^\/api\/repairs\/\d+$/.test(path))return this.services.repair(u,id);
    if(/^\/api\/service-contracts\/\d+$/.test(path))return this.services.contract(u,id);
    if(/^\/api\/pos-sales\/\d+$/.test(path))return this.pos.sale(u,id);
    if(/^\/api\/invoice-ranges\/\d+\/blanks$/.test(path))return this.invoices.blanks(u,id);
    if(/^\/api\/invoice-exchange-profiles\/\d+\/export$/.test(path))return this.invoices.export(u,id);
    if(/^\/api\/inventory-lots\/\d+$/.test(path))return this.inventory.trace(u,id);
    if(/^\/api\/documents\/\d+\/metadata$/.test(path))return this.orders.getMetadata(u,id);
    if(/^\/api\/subscriptions\/\d+$/.test(path))return this.orders.plan(u,id);
    if(/^\/api\/custom-reports\/\d+$/.test(path))return this.reports.run(u,id,query);
  }
  print(u,path,query){const form=this.forms.print(u,path,query);if(form!==undefined)return form;if(/^\/print\/expense-allocations\/\d+$/.test(path))return this.finance.printAllocation(u,path.split('/')[3]);if(/^\/print\/pos-sales\/\d+$/.test(path))return this.pos.receipt(u,path.split('/')[3]);if(/^\/print\/(repairs|service-contracts)\/\d+$/.test(path))return this.services.print(u,path.split('/')[2],path.split('/')[3]);if(/^\/print\/invoice-profiles\/\d+$/.test(path))return this.invoices.proof(u,path.split('/')[3]);if(/^\/print\/custom-reports\/\d+$/.test(path))return this.reports.print(u,path.split('/')[3],query);}
  post(u,path,b){
    const gov=this.governance.post(u,path,b);if(gov!==undefined)return gov;
    const form=this.forms.post(u,path,b);if(form!==undefined)return form;
    const id=path.split('/')[3];
    if(path==='/api/master-import-templates')return this.masters.save(u,b);
    if(path==='/api/master-imports/preview')return this.masters.preview(u,b);
    if(/^\/api\/imports\/\d+\/commit$/.test(path))return this.masters.commit(u,id);
    if(path==='/api/service-policy')return this.services.configure(u,b);
    if(path==='/api/repairs')return this.services.createRepair(u,b);
    if(/^\/api\/repairs\/\d+\/action$/.test(path))return this.services.repairAction(u,id,b);
    if(/^\/api\/repairs\/\d+\/parts$/.test(path))return this.services.repairPart(u,id,b);
    if(path==='/api/service-contracts')return this.services.createContract(u,b);
    if(/^\/api\/service-contracts\/\d+\/sell$/.test(path))return this.services.consignmentSale(u,id,b);
    if(/^\/api\/service-contracts\/\d+\/return$/.test(path))return this.services.returnContract(u,id,b);
    if(/^\/api\/rental-periods\/\d+\/charge$/.test(path))return this.services.charge(u,id);
    if(path==='/api/pos-stores')return this.pos.saveStore(u,b);
    if(path==='/api/pos-members')return this.pos.member(u,b);
    if(path==='/api/pos-promotions')return this.pos.promotion(u,b);
    if(path==='/api/loyalty-policy')return this.pos.configure(u,b);
    if(path==='/api/pos-shifts')return this.pos.shift(u,b);
    if(path==='/api/pos/quote')return this.pos.quote(u,b);
    if(path==='/api/pos/checkout')return this.pos.checkout(u,b);
    if(/^\/api\/pos-sales\/\d+\/refund$/.test(path))return this.pos.refund(u,id,b);
    if(path==='/api/invoice-ranges')return this.invoices.addRanges(u,b);
    if(path==='/api/invoice-numbers')return this.invoices.numberAction(u,b);
    if(path==='/api/invoice-print-profiles')return this.invoices.printProfile(u,b);
    if(path==='/api/invoice-exchange-profiles')return this.invoices.exchangeProfile(u,b);
    if(path==='/api/invoice-exchanges/preview')return this.invoices.preview(u,b);
    if(/^\/api\/invoice-exchanges\/\d+\/commit$/.test(path))return this.invoices.commit(u,id);
    if(path==='/api/inventory-tracking')return this.inventory.configure(u,b);
    if(path==='/api/bad-debts')return this.finance.proposeDebt(u,b);
    if(/^\/api\/bad-debts\/\d+\/action$/.test(path))return this.finance.debtAction(u,id,b);
    if(path==='/api/expense-allocations/preview')return this.finance.allocationPreview(u,b);
    if(path==='/api/expense-allocations')return this.finance.allocate(u,b);
    if(path==='/api/reconciliations/preview')return this.finance.reconcilePreview(u,b);
    if(/^\/api\/reconciliations\/\d+\/commit$/.test(path))return this.finance.reconcileCommit(u,id,b);
    if(path==='/api/bill-restrictions')return this.bills.restrictions(u,b);
    if(path==='/api/endorsements')return this.bills.endorse(u,b);
    if(/^\/api\/endorsements\/\d+\/action$/.test(path))return this.bills.endorsementAction(u,id,b);
    if(path==='/api/nontrade-bills')return this.bills.nontrade(u,b);
    if(/^\/api\/nontrade-bills\/\d+\/action$/.test(path))return this.bills.nontradeAction(u,id,b);
    if(/^\/api\/documents\/\d+\/metadata$/.test(path))return this.orders.metadata(u,id,b);
    if(path==='/api/subscriptions')return this.orders.createPlan(u,b);
    if(/^\/api\/subscriptions\/\d+\/status$/.test(path))return this.orders.changePlan(u,id,b);
    if(/^\/api\/subscription-periods\/\d+\/change$/.test(path))return this.orders.changePeriod(u,id,b);
    if(/^\/api\/subscription-periods\/\d+\/execute$/.test(path))return this.orders.execute(u,id,b);
    if(path==='/api/sku-mappings')return this.imports.saveMapping(u,b);
    if(path==='/api/order-import-templates')return this.imports.saveTemplate(u,b);
    if(path==='/api/order-imports/preview')return this.imports.preview(u,b);
    if(/^\/api\/order-imports\/\d+\/commit$/.test(path))return this.imports.commit(u,id);
    if(path==='/api/custom-reports')return this.reports.save(u,b);
  }
}
