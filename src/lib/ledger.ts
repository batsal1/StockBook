import { sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';

/** + means the party owes the shop; − means the shop owes the party. Cancelled bills are ignored. */
export async function partyBalances(tx: Tx, shopId: string, partyId?: string): Promise<Map<string, number>> {
  const res = await tx.execute(sql`
    select p.id,
      p.opening_balance_paise
      + coalesce((select sum((case when i.type in ('sale', 'purchase_return') then 1 else -1 end) * (i.total_paise - i.paid_paise))
                  from invoices i where i.party_id = p.id and i.status = 'active'), 0)
      + coalesce((select sum(case pm.kind when 'payment_out' then pm.amount_paise when 'payment_in' then -pm.amount_paise else 0 end)
                  from payments pm where pm.party_id = p.id), 0) as balance
    from parties p
    where p.shop_id = ${shopId} ${partyId ? sql`and p.id = ${partyId}` : sql``}`);
  return new Map((res.rows as { id: string; balance: number }[]).map((r) => [r.id, Number(r.balance)]));
}

/** Cash in hand and bank (UPI, card and bank transfers land in the bank) as of a date. */
export async function accountBalances(tx: Tx, shopId: string, upTo?: string) {
  const dateCut = (col: string) => (upTo ? sql`and ${sql.raw(col)} <= ${upTo}` : sql``);
  const res = await tx.execute(sql`
    with inv as (
      select case when pay_mode = 'cash' then 'cash' else 'bank' end as acct,
             sum((case when type in ('sale', 'purchase_return') then 1 else -1 end) * paid_paise) as amt
      from invoices where shop_id = ${shopId} and status = 'active' and pay_mode <> 'credit' ${dateCut('date')}
      group by 1),
    pay as (
      select kind, case when mode = 'cash' then 'cash' else 'bank' end as acct, sum(amount_paise) as amt
      from payments where shop_id = ${shopId} ${dateCut('date')} group by 1, 2)
    select
      (select opening_cash_paise from shops where id = ${shopId}) as "openingCash",
      (select opening_bank_paise from shops where id = ${shopId}) as "openingBank",
      coalesce((select amt from inv where acct = 'cash'), 0) as "invCash",
      coalesce((select amt from inv where acct = 'bank'), 0) as "invBank",
      coalesce((select sum(case when kind in ('payment_in', 'income') then amt when kind in ('payment_out', 'expense') then -amt else 0 end) from pay where acct = 'cash'), 0) as "payCash",
      coalesce((select sum(case when kind in ('payment_in', 'income') then amt when kind in ('payment_out', 'expense') then -amt else 0 end) from pay where acct = 'bank'), 0) as "payBank",
      coalesce((select sum(case kind when 'deposit' then amt when 'withdraw' then -amt else 0 end) from pay), 0) as "transfer"`);
  const r = res.rows[0] as Record<string, number>;
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    cashPaise: n('openingCash') + n('invCash') + n('payCash') - n('transfer'),
    bankPaise: n('openingBank') + n('invBank') + n('payBank') + n('transfer'),
  };
}
