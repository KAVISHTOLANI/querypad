import { expect, test } from '@playwright/test';
import { checkMobile, snap } from './helpers';

test('load a CSV, query it, export the result', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('a real question');
  await page.waitForTimeout(1000);
  await snap(page, 'landing');
  await checkMobile(page, 'landing-mobile');

  await page.getByRole('link', { name: 'Open the editor' }).first().click();
  await page.getByLabel('SQL').click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('result-meta')).toContainText('5 rows');
  await snap(page, 'query');
  await checkMobile(page, 'query-mobile');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Tables' }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'Stock Levels.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,item,on_hand\nA1,Kettle,4\nB2,Mug,0\nC3,Lamp,12\n') });
  await expect(page.getByText('Loaded stock_levels: 3 rows, 3 columns.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('rowheader', { name: 'stock_levels' })).toBeVisible();
  await snap(page, 'tables');
  await checkMobile(page);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Query' }).click();
  await page.getByLabel('SQL').fill('SELECT item FROM stock_levels WHERE on_hand = 0');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByRole('table', { name: 'Query result' })).toContainText('Mug');
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV' }).click();
  expect((await dl).suggestedFilename()).toBe('query-result.csv');
  await page.getByLabel('SQL').fill('SELECT item, COUNT(*) FROM stock_levels GROUP BY on_hand');
  await page.getByRole('button', { name: 'Run query' }).click();
  await expect(page.getByTestId('sql-error')).toContainText('item must be in GROUP BY');
  await snap(page, 'error');
});
