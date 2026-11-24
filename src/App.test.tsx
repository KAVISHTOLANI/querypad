import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

describe('QueryPad', () => {
  it('runs the default join query with Cmd+Enter', async () => {
    window.location.hash = '/query';
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByLabelText('SQL'));
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(screen.getByTestId('result-meta')).toHaveTextContent('5 rows');
    const table = screen.getByRole('table', { name: 'Query result' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['name', 'city', 'spent']);
  });

  it('shows errors with a caret and recovers', async () => {
    window.location.hash = '/query';
    const user = userEvent.setup();
    render(<App />);
    const ta = screen.getByLabelText('SQL');
    fireEvent.change(ta, { target: { value: 'SELECT colour FROM products' } });
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    expect(screen.getByTestId('sql-error')).toHaveTextContent('No column named colour. Columns: id, name, category, price.');
    expect(document.querySelector('.caret-line')).toHaveTextContent('1 | SELECT colour FROM products');
    fireEvent.change(ta, { target: { value: "SELECT name FROM products WHERE category = 'Toys'" } });
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    expect(screen.getByText('No rows matched')).toBeInTheDocument();
  });

  it('loads examples, inserts schema names and saves queries', async () => {
    window.location.hash = '/query';
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByLabelText('Examples'), 'Customers with no orders');
    expect(screen.getByLabelText('SQL')).toHaveValue('SELECT c.name, c.city\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.id IS NULL;');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Name the query.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Save as'), 'Lapsed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Query saved.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('SQL'), { target: { value: 'SELECT * FROM ' } });
    await user.click(screen.getByRole('button', { name: 'products' }));
    expect(screen.getByLabelText('SQL')).toHaveValue('SELECT * FROM products');
    window.location.hash = '/saved';
    expect(await screen.findByText('Lapsed')).toBeInTheDocument();
  });

  it('adds a pasted table, validates it and queries it', async () => {
    window.location.hash = '/tables';
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Add table' }));
    expect(screen.getByText('Name the table.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Table name'), 'Sales!');
    await user.click(screen.getByLabelText('CSV'));
    await user.paste('region,total\nNorth,120\nSouth,80');
    await user.click(screen.getByRole('button', { name: 'Add table' }));
    expect(screen.getByText(/Use lowercase letters/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Table name'));
    await user.type(screen.getByLabelText('Table name'), 'sales');
    await user.click(screen.getByRole('button', { name: 'Add table' }));
    expect(screen.getByText('Loaded sales: 2 rows, 2 columns.')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'total (number)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove orders' }));
    expect(screen.queryByRole('rowheader', { name: /^orders/ })).not.toBeInTheDocument();
    window.location.hash = '/query';
    const ta = await screen.findByLabelText('SQL');
    fireEvent.change(ta, { target: { value: 'SELECT SUM(total) AS t FROM sales' } });
    await user.click(screen.getByRole('button', { name: 'Run query' }));
    expect(within(screen.getByRole('table', { name: 'Query result' })).getByText('200')).toBeInTheDocument();
  });
});
