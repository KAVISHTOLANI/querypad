import { describe, expect, it } from 'vitest';
import { SqlError, parse, run, tableFromCSV, tableName, tokenize, type Table } from './sql';

const orders = tableFromCSV('orders', `id,customer_id,product,qty,price,status
1,10,Kettle,1,24.5,shipped
2,11,Mug,4,6,shipped
3,10,Mug,2,6,pending
4,12,Teapot,1,32,cancelled
5,11,Kettle,2,24.5,shipped
6,13,Tray,,12,pending`);
const customers = tableFromCSV('customers', `id,name,city
10,Ada Okafor,Leeds
11,Bram Visser,York
12,Chen Li,Leeds
14,Dee Ramos,Hull`);
const T: Table[] = [orders, customers];
const q = (sql: string) => run(sql, T);

describe('loading', () => {
  it('infers column names and types', () => {
    expect(orders.columns).toEqual(['id', 'customer_id', 'product', 'qty', 'price', 'status']);
    expect(orders.types).toEqual(['number', 'number', 'text', 'number', 'number', 'text']);
    expect(orders.rows[5][3]).toBeNull();
    expect(tableFromCSV('x', 'First Name,first name,2024\na,b,c').columns).toEqual(['first_name', 'first_name_2', 'c_2024']);
    expect(tableName('Sales Q1 (2025).csv')).toBe('sales_q1_2025');
    expect(tableName('2025.csv')).toBe('t_2025');
  });
});

describe('parsing', () => {
  it('tokenizes strings with escaped quotes and comments', () => {
    expect(tokenize("SELECT 'it''s' -- hi\nFROM t").map((t) => t.v)).toEqual(['SELECT', "it's", 'FROM', 't', '']);
  });
  it('gives helpful errors with positions', () => {
    expect(() => parse('SELECT name customers')).toThrow(/Expected FROM near the end/);
    expect(() => parse('DELETE FROM orders')).toThrow(/read-only/);
    expect(() => parse("SELECT * FROM orders WHERE product = 'Mug")).toThrow(/Unclosed string/);
    try { parse('SELECT * FROM orders WHERE'); } catch (e) { expect((e as SqlError).pos).toBe(26); }
    expect(() => parse('SELECT 1 FROM a; SELECT 2 FROM b')).toThrow(/one query at a time/);
  });
});

describe('queries', () => {
  it('selects, filters, orders and limits', () => {
    const r = q("SELECT product, qty * price AS total FROM orders WHERE status <> 'cancelled' AND qty IS NOT NULL ORDER BY total DESC, product LIMIT 3");
    expect(r.columns).toEqual(['product', 'total']);
    expect(r.rows).toEqual([['Kettle', 49], ['Mug', 24], ['Kettle', 24.5]].sort((a, b) => (b[1] as number) - (a[1] as number) || String(a[0]).localeCompare(String(b[0]))));
  });
  it('supports LIKE, IN, BETWEEN and functions', () => {
    expect(q("SELECT id FROM orders WHERE product LIKE 'k%'").rows.flat()).toEqual([1, 5]);
    expect(q('SELECT id FROM orders WHERE customer_id IN (12, 13)').rows.flat()).toEqual([4, 6]);
    expect(q('SELECT id FROM orders WHERE price BETWEEN 6 AND 12 ORDER BY id').rows.flat()).toEqual([2, 3, 6]);
    expect(q("SELECT UPPER(product), ROUND(price / 3, 2), COALESCE(qty, 0) FROM orders WHERE id = 6").rows[0]).toEqual(['TRAY', 4, 0]);
  });
  it('groups with aggregates, HAVING and alias ordering', () => {
    const r = q('SELECT status, COUNT(*) AS n, SUM(qty) AS units, AVG(price) FROM orders GROUP BY status HAVING n > 1 ORDER BY n DESC');
    expect(r.columns).toEqual(['status', 'n', 'units', 'AVG(price)']);
    expect(r.rows).toEqual([['shipped', 3, 7, 18.333333333], ['pending', 2, 2, 9]]);
    expect(q('SELECT COUNT(DISTINCT product), MAX(price), MIN(product) FROM orders').rows).toEqual([[4, 32, 'Kettle']]);
    expect(q("SELECT COUNT(*), SUM(qty) FROM orders WHERE product = 'None'").rows).toEqual([[0, null]]);
  });
  it('rejects ungrouped columns and aggregates in WHERE', () => {
    expect(() => q('SELECT product, COUNT(*) FROM orders GROUP BY status')).toThrow(/product must be in GROUP BY/);
    expect(() => q('SELECT id FROM orders WHERE COUNT(*) > 1')).toThrow(/HAVING/);
  });
  it('joins with aliases, including LEFT JOIN nulls', () => {
    const r = q('SELECT c.name, SUM(o.qty * o.price) AS spent FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.name ORDER BY spent DESC');
    expect(r.rows).toEqual([['Bram Visser', 73], ['Ada Okafor', 36.5], ['Chen Li', 32]]);
    const l = q('SELECT c.name, COUNT(o.id) AS orders FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY orders, c.name');
    expect(l.rows[0]).toEqual(['Dee Ramos', 0]);
    expect(() => q('SELECT id FROM orders o JOIN customers c ON o.customer_id = c.id')).toThrow(/more than one table — write o.id or c.id/);
  });
  it('chains several joins', () => {
    const products = tableFromCSV('products', 'id,name\nKettle,K\n');
    void products;
    const items = tableFromCSV('cities', 'city,region\nLeeds,North\nYork,North\nHull,North');
    const r = run('SELECT ci.region, COUNT(*) AS n FROM orders o JOIN customers c ON o.customer_id = c.id JOIN cities ci ON ci.city = c.city GROUP BY ci.region', [orders, customers, items]);
    expect(r.rows).toEqual([['North', 5]]);
  });
  it('expands * and supports DISTINCT, OFFSET and NULL ordering', () => {
    expect(q('SELECT * FROM customers LIMIT 1').columns).toEqual(['id', 'name', 'city']);
    expect(q('SELECT DISTINCT city FROM customers ORDER BY city').rows.flat()).toEqual(['Hull', 'Leeds', 'York']);
    expect(q('SELECT id FROM orders ORDER BY id LIMIT 2 OFFSET 2').rows.flat()).toEqual([3, 4]);
    expect(q('SELECT qty FROM orders ORDER BY qty').rows.flat().pop()).toBeNull();
  });
  it('explains unknown tables and columns', () => {
    expect(() => q('SELECT * FROM sales')).toThrow(/No table named sales. Tables: orders, customers/);
    expect(() => q('SELECT colour FROM orders')).toThrow(/No column named colour/);
  });
});
