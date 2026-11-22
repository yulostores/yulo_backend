// "Online available" (MenuItem.availableOnline): a dish switched off for online orders is a
// dine-in-only dish — it stays on the table-QR menu and the waiter app, but the delivery app
// never lists it, and a cart or delivery/takeaway order can't contain it.

/** Mongo condition for dishes that may be ordered online (the field is absent on old items). */
export const ONLINE_ITEM_FILTER = { availableOnline: { $ne: false } };

export const isOnlineItem = (item) => item?.availableOnline !== false;

/** The cached menu tree with dine-in-only dishes taken out (a copy — the cache is untouched). */
export const onlineMenuOf = (menu = []) =>
  menu.map((category) => ({
    ...category,
    items: (category.items ?? []).filter(isOnlineItem),
    subCategories: (category.subCategories ?? []).map((sub) => ({
      ...sub,
      items: (sub.items ?? []).filter(isOnlineItem),
    })),
  }));
