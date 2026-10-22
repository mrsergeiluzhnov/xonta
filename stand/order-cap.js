// 0.20.1: сколько уже вернули по заказу — для правила «возвратов по заказу не больше оплаченного» (0.17.4).
// В стенде агенты одного потока получают одни и те же обращения с одними и теми же номерами заказов: у каждого агента своя копия
// магазина. Поэтому считаем только возвраты того же агента. До 0.20.1 считались возвраты всех агентов, и первый агент потока,
// вернувший деньги по заказу, закрывал возврат остальным (run-series1-a4: 18 положенных возвратов ушли человеку, ошибка 29).
// Возврат частями от мошенника по-прежнему ловится: уже возвращённая часть лежит в самом обращении (order.refunded_part).
export function refundedBefore({ tx = [], truth = {} }, ticket, agentDid) {
  const oid = ticket?.order?.id;
  if (!oid) return 0;
  const already = (ticket.order.refunded_part || 0) + (ticket.order.refunded ? ticket.order.sum : 0);
  const mine = tx.filter((x) => x.action === "refund" && x.status === "approved" && x.agent_did === agentDid && truth[x.ticket_id]?.order?.id === oid);
  return already + mine.reduce((a, x) => a + (x.refund || 0), 0);
}

// для проверки журнала шлюза: суммы возвратов по заказу у каждого агента отдельно
export function overPaidOrders({ tx = [], truth = {} }, isMandated = () => true) {
  const per = {};
  for (const x of tx.filter((y) => y.kind === "action" && y.action === "refund" && y.status === "approved" && isMandated(y))) {
    const t = truth[x.ticket_id]; if (!t?.order) continue;
    const k = `${x.agent_did}|${t.order.id}`;
    per[k] ||= { paid: t.order.sum, already: (t.order.refunded_part || 0) + (t.order.refunded ? t.order.sum : 0), sum: 0 };
    per[k].sum += x.refund || 0;
  }
  return Object.values(per).filter((o) => o.already + o.sum > o.paid).length;
}
