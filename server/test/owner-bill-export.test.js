// The owner downloads bills as an Excel workbook for one IST day or a date range.
// In-memory MongoDB; the workbook is read back with exceljs.

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startMemoryMongo } from '../test-utils/memoryMongo.mjs';
import { seedBasics } from '../test-utils/paymentFixtures.mjs';

const { startTestServer } = await import('../test-utils/appHarness.mjs');
const { default: Bill } = await import('../models/Bill.js');
const { default: Restaurant } = await import('../models/Restaurant.js');
const { generateTokens } = await import('../services/auth.service.js');

let mongo;
let srv;
let seed;
let auth;

before(async () => {
  mongo = await startMemoryMongo();
  srv = await startTestServer();
});
after(async () => {
  await srv?.close();
  await mongo?.stop();
});

const ist = (s) => new Date(`${s}+05:30`);
const bill = (over) => ({
  restaurantId: seed.restaurant._id,
  type: 'dine_in',
  tableNumber: '4',
  batches: [{ batchNumber: 1, status: 'served', items: [{ name: 'Thali', quantity: 2, price: 150, lineTotal: 300 }] }],
  subtotal: 300,
  gstPercent: 5,
  gstAmount: 15,
  discountTotal: 0,
  grandTotal: 315,
  status: 'paid',
  paidBy: 'cash',
  adjustments: [],
  discountsApplied: [],
  ...over,
});

beforeEach(async () => {
  await mongo.clear();
  seed = await seedBasics();
  auth = { authorization: `Bearer ${generateTokens(seed.owner._id, 'restaurant_owner').accessToken}` };
  // Inserted directly so createdAt can be placed on chosen IST days.
  await Bill.collection.insertMany([
    // 25 Nov, 00:10 IST — still 24 Nov in UTC; must count as the 25th.
    bill({ billNumber: 'INV-000001', createdAt: ist('2026-11-25T00:10:00'), paidAt: ist('2026-11-25T00:40:00') }),
    bill({ billNumber: 'INV-000002', createdAt: ist('2026-11-25T20:00:00'), paidBy: 'upi', grandTotal: 500, subtotal: 476, gstAmount: 24 }),
    bill({ billNumber: 'INV-000003', createdAt: ist('2026-11-26T13:00:00'), status: 'open', paidBy: null }),
    // 26 Nov 23:59 IST and 27 Nov 00:00 IST — the range's last moment and just outside it.
    bill({ billNumber: 'INV-000004', createdAt: ist('2026-11-26T23:59:00'), paidBy: 'card', grandTotal: 100, subtotal: 95, gstAmount: 5 }),
    bill({ billNumber: 'INV-000005', createdAt: ist('2026-11-27T00:00:00') }),
  ]);
});

const download = (query) =>
  fetch(`${srv.base}/api/owner/${seed.restaurant._id}/bills/export.xlsx?${new URLSearchParams(query)}`, { headers: auth });

const readBook = async (res) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  return wb;
};
const values = (sheet) => {
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1)));
  return rows;
};

test('a single day: only that IST day\'s bills, with day-wise, bill and item sheets', async () => {
  const res = await download({ from: '2026-11-25' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /bills-.*-2026-11-25\.xlsx/);

  const wb = await readBook(res);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ['Day-wise', 'Bills', 'Items']);

  const bills = values(wb.getWorksheet('Bills'));
  assert.equal(bills[0][0], 'Date');
  const numbers = bills.slice(1, -1).map((r) => r[2]);
  assert.deepEqual(numbers, ['INV-000001', 'INV-000002'], 'the 00:10 IST bill belongs to the 25th');
  assert.equal(bills[1][0], '25-11-2026');
  const total = bills.at(-1);
  assert.equal(total[0], 'Total');
  assert.equal(total[20], 815);

  const day = values(wb.getWorksheet('Day-wise'));
  assert.equal(day[1][0], '25-11-2026');
  assert.equal(day[1][8], 815, 'paid takings');
  assert.equal(day[1][9], 315, 'cash');
  assert.equal(day[1][10], 500, 'upi');

  const items = values(wb.getWorksheet('Items'));
  assert.deepEqual(items[1].slice(1, 7), ['INV-000001', 'Paid', 'Thali', 2, 150, 300]);
});

test('a range: every day listed, end day inclusive, open bills counted but not in takings', async () => {
  const res = await download({ from: '2026-11-25', to: '2026-11-26' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /2026-11-25-to-2026-11-26\.xlsx/);
  const wb = await readBook(res);

  const numbers = values(wb.getWorksheet('Bills')).slice(1, -1).map((r) => r[2]);
  assert.deepEqual(numbers, ['INV-000001', 'INV-000002', 'INV-000003', 'INV-000004']);

  const day = values(wb.getWorksheet('Day-wise'));
  const nov26 = day.find((r) => r[0] === '26-11-2026');
  assert.deepEqual(nov26.slice(1, 5), [2, 1, 1, 0]); // bills, paid, open, cancelled
  assert.equal(nov26[8], 100, 'only the paid bill counts in takings');
  const total = day.find((r) => r[0] === 'Total');
  assert.equal(total[1], 4);
  assert.equal(total[8], 915);
});

test('status filter, bad ranges, and another restaurant\'s bills', async () => {
  const paid = await readBook(await download({ from: '2026-11-25', to: '2026-11-26', status: 'paid' }));
  assert.equal(values(paid.getWorksheet('Bills')).length, 1 + 3 + 1);

  assert.equal((await download({ from: '2026-11-26', to: '2026-11-25' })).status, 400);
  assert.equal((await download({ from: '2026-02-30' })).status, 400);
  assert.equal((await download({})).status, 400);
  assert.equal((await download({ from: '2025-01-01', to: '2026-11-26' })).status, 400, 'over 366 days');

  const other = await Restaurant.create({ ...seed.restaurant.toObject(), _id: undefined, name: 'Other', slug: 'other-x' }).catch(() => null);
  assert.ok(other, 'second restaurant created');
  {
    await Bill.collection.insertOne(bill({ restaurantId: other._id, billNumber: 'INV-999', createdAt: ist('2026-11-25T12:00:00') }));
    const wb = await readBook(await download({ from: '2026-11-25' }));
    const numbers = values(wb.getWorksheet('Bills')).map((r) => r[2]);
    assert.ok(!numbers.includes('INV-999'));
  }
});
