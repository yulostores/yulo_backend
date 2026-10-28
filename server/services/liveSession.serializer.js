// The one shape a live session has wherever an owner sees it: the A4 list, the A4 detail header
// and the A6 `session_updated` emit. Fields are picked one by one — never spread from the
// document — so nothing added to CustomerSession later (or the customer's userId) leaks out.

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * `session` is a CustomerSession (lean or hydrated). `offerEligibility` is A4's verdict,
 * `{ eligible, reason }`; without it both fields are null.
 */
export const toSessionRow = (session, { offerEligibility } = {}) => {
  const items = session.cart?.items ?? [];
  return {
    id: String(session._id),
    displayName: session.displayName,
    isGuest: Boolean(session.isGuest),
    pastOrderCount: session.pastOrderCount ?? 0,
    status: session.status,
    startedAt: iso(session.startedAt),
    lastActivityAt: iso(session.lastActivityAt),
    lastEvent: session.lastEvent?.type
      ? { type: session.lastEvent.type, label: session.lastEvent.label, at: iso(session.lastEvent.at) }
      : null,
    cart: {
      itemCount: items.reduce((sum, line) => sum + line.qty, 0),
      totalPaise: session.cart?.totalPaise ?? 0,
      items: items.map((line) => ({ name: line.name, qty: line.qty })),
    },
    cameFromSearch: session.cameFromSearch ?? null,
    eventCount: session.eventCount ?? 0,
    orderId: session.orderId ? String(session.orderId) : null,
    offerEligible: offerEligibility ? Boolean(offerEligibility.eligible) : null,
    notEligibleReason: offerEligibility && !offerEligibility.eligible ? offerEligibility.reason ?? null : null,
  };
};
