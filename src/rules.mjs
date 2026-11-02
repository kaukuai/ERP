// Pure business rules shared by migrations, core transactions and finance.
export const FUND_ACCOUNTS={customer_advance:'2400',supplier_advance:'1400',customer_credit:'2300',supplier_credit:'1150'};
export function billingDates(date,partner){
 const [year,month,day]=date.split('-').map(Number),mode=partner.payment_mode||'days';
 let end=date;
 if(mode!=='days'){
  let y=year,m=month;const cutoff=mode==='month_end'?31:Number(partner.closing_day||31);
  const monthDays=(yy,mm)=>new Date(Date.UTC(yy,mm,0)).getUTCDate();
  if(day>Math.min(cutoff,monthDays(y,m))){m++;if(m>12){m=1;y++;}}
  end=`${y}-${String(m).padStart(2,'0')}-${String(Math.min(cutoff,monthDays(y,m))).padStart(2,'0')}`;
 }
 return {period:end.slice(0,7),closing_date:end,due_date:new Date(Date.parse(end+'T00:00:00Z')+Number(partner.payment_days||0)*86400000).toISOString().slice(0,10)};
}
