import { useMemo, useRef, useState, type ReactNode } from 'react';
import { DemoTag, EmptyState, Field, Landing, NotFound, Notice, PageHead, Shell, downloadText, loadJSON, readFileText, saveJSON, uid, useFlash, usePersistentState, useRoute } from './shared/ui';
import { Pager } from './shared/table';
import { toCSV } from './shared/csv';
import { SqlError, display, run, tableFromCSV, tableName, type Result, type Table } from './lib/sql';

const KEY = 'querypad:store';
const TABLES_KEY = 'querypad:tables';
const NAV = [
  { to: '/', label: 'Overview' },
  { to: '/query', label: 'Query' },
  { to: '/tables', label: 'Tables' },
  { to: '/saved', label: 'Saved' },
];
const MAX_ROWS = 20000;

/* ---------- Demo data (fictional) ---------- */
function demoTables(): Table[] {
  const names = ['Ada Okafor', 'Bram Visser', 'Chen Li', 'Dee Ramos', 'Esi Mensah', 'Farid Haddad', 'Greta Lund', 'Hiro Sato', 'Ines Duarte', 'Jon Byrne', 'Kai Moreno', 'Lena Weiss'];
  const cities = ['Leeds', 'York', 'Leeds', 'Hull', 'Bristol', 'York', 'Bristol', 'Leeds', 'Hull', 'York', 'Bristol', 'Leeds'];
  const products: [string, string, number][] = [['Kettle', 'Kitchen', 24.5], ['Mug', 'Kitchen', 6], ['Teapot', 'Kitchen', 32], ['Tray', 'Home', 12], ['Lamp', 'Home', 45], ['Cushion', 'Home', 18], ['Notebook', 'Stationery', 4.5], ['Pen set', 'Stationery', 9]];
  const statuses = ['shipped', 'shipped', 'shipped', 'pending', 'cancelled'];
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 16807) % 2147483647; return seed % n; };
  const orders: string[] = ['id,order_date,customer_id,product_id,qty,status'];
  for (let i = 1; i <= 60; i++) {
    const m = 1 + (i % 6), d = 1 + rnd(27);
    orders.push([i, `2025-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, 1 + rnd(11), 1 + rnd(7), 1 + rnd(4), statuses[rnd(5)]].join(','));
  }
  return [
    tableFromCSV('orders', orders.join('\n')),
    tableFromCSV('customers', ['id,name,city,joined', ...names.map((n, i) => `${i + 1},${n},${cities[i]},2024-${String(1 + (i % 12)).padStart(2, '0')}-15`)].join('\n')),
    tableFromCSV('products', ['id,name,category,price', ...products.map((p, i) => `${i + 1},${p[0]},${p[1]},${p[2]}`)].join('\n')),
  ];
}

const EXAMPLES: [string, string][] = [
  ['Orders by status', "SELECT status, COUNT(*) AS orders, SUM(qty) AS units\nFROM orders\nGROUP BY status\nORDER BY orders DESC;"],
  ['Top customers by spend', 'SELECT c.name, c.city, ROUND(SUM(o.qty * p.price), 2) AS spent\nFROM orders o\nJOIN customers c ON o.customer_id = c.id\nJOIN products p ON o.product_id = p.id\nGROUP BY c.name, c.city\nORDER BY spent DESC\nLIMIT 5;'],
  ['Monthly revenue', "SELECT SUBSTR(o.order_date, 1, 7) AS month, ROUND(SUM(o.qty * p.price), 2) AS revenue\nFROM orders o\nJOIN products p ON o.product_id = p.id\nWHERE o.status = 'shipped'\nGROUP BY month\nORDER BY month;"],
  ['Customers with no orders', 'SELECT c.name, c.city\nFROM customers c\nLEFT JOIN orders o ON o.customer_id = c.id\nWHERE o.id IS NULL;'],
  ['Kitchen products', "SELECT name, price\nFROM products\nWHERE category = 'Kitchen' AND price < 30\nORDER BY price;"],
];

interface Saved { id: string; name: string; sql: string }
interface Run { at: string; sql: string; rows: number | null; error?: string }
interface Store { sql: string; saved: Saved[]; history: Run[]; demo: boolean }
const DEFAULT_SQL = EXAMPLES[1][1];

export default function App() {
  const [route] = useRoute();
  const [store, setStore] = usePersistentState<Store>(KEY, { sql: DEFAULT_SQL, saved: [{ id: 's1', name: 'Top customers by spend', sql: EXAMPLES[1][1] }], history: [], demo: true });
  const [tables, setTablesState] = useState<Table[]>(() => loadJSON<Table[] | null>(TABLES_KEY, null) ?? demoTables());
  const [storageWarn, setStorageWarn] = useState(false);
  const setTables = (t: Table[]) => { setTablesState(t); setStorageWarn(!saveJSON(TABLES_KEY, t)); };
  const ctx = { store, setStore, tables, setTables, storageWarn };
  let page: ReactNode;
  if (route === '/') page = <Home tables={tables} />;
  else if (route === '/query') page = <QueryPage {...ctx} />;
  else if (route === '/tables') page = <TablesPage {...ctx} />;
  else if (route === '/saved') page = <SavedPage {...ctx} />;
  else page = <NotFound />;
  return (
    <Shell name="QueryPad" wordmark={['Query', 'Pad']} nav={NAV} route={route} cta={{ to: '/query', label: 'Open the editor' }} footerNote="Queries run in your browser. CSV files are never uploaded.">
      {page}
    </Shell>
  );
}

type Ctx = { store: Store; setStore: (s: Store | ((s: Store) => Store)) => void; tables: Table[]; setTables: (t: Table[]) => void; storageWarn: boolean };

/* ---------- Result table ---------- */
function ResultTable({ result, caption }: { result: Result; caption: string }) {
  const [page, setPage] = useState(1);
  const size = 25;
  const pages = Math.max(1, Math.ceil(result.rows.length / size));
  const p = Math.min(page, pages);
  const rows = result.rows.slice((p - 1) * size, p * size);
  const numeric = result.columns.map((_, i) => result.rows.length > 0 && result.rows.every((r) => r[i] === null || typeof r[i] === 'number'));
  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="table result-table">
          <caption className="sr-only">{caption}</caption>
          <thead><tr>{result.columns.map((c, i) => <th key={i} scope="col" className={numeric[i] ? 'num' : ''}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((v, i) => <td key={i} className={`${numeric[i] ? 'num' : ''} ${v === null ? 'null' : ''}`}>{display(v)}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {pages > 1 && <Pager table={{ page: p, pages, from: (p - 1) * size + 1, to: Math.min(p * size, result.rows.length), total: result.rows.length, setPage }} />}
    </div>
  );
}

/* ---------- Home ---------- */
function Home({ tables }: { tables: Table[] }) {
  const demo = useMemo(() => { try { return run(EXAMPLES[0][1], demoTables()); } catch { return null; } }, []);
  return (
    <Landing
      eyebrow="SQL for CSV files"
      title={<>Ask your spreadsheet <em>a real question.</em></>}
      lead="Drop in CSV files and query them with SQL — joins, grouping, filters and sorting — right in your browser. Nothing is uploaded, and errors tell you exactly what to fix."
      primary={{ href: '#/query', label: 'Open the editor' }}
      secondary={{ href: '#/tables', label: 'Load a CSV' }}
      previewLabel="Query result"
      preview={
        <div className="hero-qp">
          <pre className="sql-mini"><span className="kw">SELECT</span> status, <span className="kw">COUNT</span>(*) <span className="kw">AS</span> orders, <span className="kw">SUM</span>(qty) <span className="kw">AS</span> units{'\n'}<span className="kw">FROM</span> orders <span className="kw">GROUP BY</span> status{'\n'}<span className="kw">ORDER BY</span> orders <span className="kw">DESC</span>;</pre>
          {demo && <ResultTable result={demo} caption="Demo result" />}
          {demo && <p className="small muted mono">{demo.rows.length} rows · scanned {demo.scanned}</p>}
        </div>
      }
      meta={['Runs in your browser', 'No account', `${tables.length} demo tables`]}
      steps={[
        { title: 'Load CSVs', body: 'Upload or paste. Column names and number columns are detected automatically.' },
        { title: 'Write SQL', body: 'SELECT, JOIN, WHERE, GROUP BY, HAVING, ORDER BY, LIMIT — with ⌘/Ctrl + Enter to run.' },
        { title: 'Export', body: 'Download the result as CSV, or save the query to run again.' },
      ]}
      features={[
        { title: 'Joins', body: 'Inner and left joins with table aliases; equality joins use a hash join so they stay fast.' },
        { title: 'Aggregates', body: 'COUNT, SUM, AVG, MIN and MAX, with DISTINCT and HAVING.' },
        { title: 'Plain-English errors', body: 'Unknown columns list what exists; ungrouped columns tell you how to fix them.' },
        { title: 'Read-only', body: 'Only SELECT is supported, so your data can’t be changed by a stray query.' },
      ]}
      closing={{ title: <>Faster than a pivot table. <em>Clearer, too.</em></>, action: { href: '#/query', label: 'Try a query' } }}
    />
  );
}

/* ---------- Query ---------- */
function ErrorBox({ err, sql }: { err: SqlError | Error; sql: string }) {
  const pos = err instanceof SqlError ? err.pos : undefined;
  let marker: ReactNode = null;
  if (pos !== undefined) {
    const before = sql.slice(0, pos);
    const lineNo = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = sql.slice(lineStart).split('\n')[0];
    marker = <pre className="caret-line" aria-hidden="true">{`${lineNo} | ${line}\n${' '.repeat(String(lineNo).length + 3 + (pos - lineStart))}^`}</pre>;
  }
  return <div className="stack"><Notice kind="error"><span data-testid="sql-error">{err.message}</span>{pos !== undefined && <span className="sr-only"> At line {sql.slice(0, pos).split('\n').length}.</span>}</Notice>{marker}</div>;
}

function QueryPage({ store, setStore, tables }: Ctx) {
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [ran, setRan] = useState('');
  const [name, setName] = useState('');
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [flash, setFlash] = useFlash();
  const ta = useRef<HTMLTextAreaElement>(null);
  const sql = store.sql;
  function execute() {
    const text = sql.trim();
    if (!text) { setErr(new Error('Write a query first, e.g. SELECT * FROM orders LIMIT 10.')); setResult(null); return; }
    setRan(text);
    try {
      const r = run(text, tables);
      setResult(r); setErr(null);
      setStore((s) => ({ ...s, history: [{ at: new Date().toISOString(), sql: text, rows: r.rows.length }, ...s.history].slice(0, 20) }));
    } catch (e) {
      const er = e instanceof Error ? e : new Error(String(e));
      setErr(er); setResult(null);
      setStore((s) => ({ ...s, history: [{ at: new Date().toISOString(), sql: text, rows: null, error: er.message }, ...s.history].slice(0, 20) }));
    }
  }
  function insert(text: string) {
    const el = ta.current;
    if (!el) return;
    const a = el.selectionStart ?? sql.length, b = el.selectionEnd ?? sql.length;
    const next = sql.slice(0, a) + text + sql.slice(b);
    setStore((s) => ({ ...s, sql: next }));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + text.length, a + text.length); });
  }
  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setNameErr('Name the query.');
    if (!sql.trim()) return setNameErr('There’s no query to save.');
    setNameErr(null);
    setStore((s) => ({ ...s, saved: [{ id: uid('s'), name: name.trim().slice(0, 60), sql: sql.trim() }, ...s.saved] }));
    setName('');
    setFlash({ kind: 'success', text: 'Query saved.' });
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Query" title={<>Write <em>a query.</em></>} description={<>Press <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> to run. Only SELECT is supported.</>} />
      <div className="qp-layout">
        <div className="stack">
          <div className="card stack">
            <div className="field">
              <label htmlFor="sql">SQL</label>
              <textarea id="sql" ref={ta} className="code sql-input" spellCheck={false} rows={9} value={sql} aria-describedby="sql-hint" onChange={(e) => setStore((s) => ({ ...s, sql: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); execute(); } }} />
              <span className="hint" id="sql-hint">Strings use single quotes. Names are case-insensitive.</span>
            </div>
            <div className="row-between">
              <div className="row-gap">
                <button type="button" className="btn btn-primary" onClick={execute}>Run query</button>
                <Field label="Examples" className="inline-field">{(p) => <select {...p} value="" onChange={(e) => { const ex = EXAMPLES.find((x) => x[0] === e.target.value); if (ex) setStore((s) => ({ ...s, sql: ex[1] })); }}><option value="">Load an example…</option>{EXAMPLES.map(([n]) => <option key={n}>{n}</option>)}</select>}</Field>
              </div>
              <form className="row-gap" onSubmit={save} noValidate>
                <Field label="Save as" className="inline-field" error={nameErr}>{(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Query name" />}</Field>
                <button type="submit" className="btn">Save</button>
              </form>
            </div>
            {flash && <Notice kind={flash.kind} onDismiss={() => setFlash(null)}>{flash.text}</Notice>}
          </div>
          <section className="card stack" aria-labelledby="res-t" aria-live="polite">
            <div className="row-between">
              <h2 id="res-t" className="h3">Result</h2>
              {result && (
                <div className="row-gap">
                  <span className="small muted mono" data-testid="result-meta">{result.rows.length} row{result.rows.length === 1 ? '' : 's'} · scanned {result.scanned} · {result.ms} ms</span>
                  <button type="button" className="btn btn-sm" disabled={!result.rows.length} onClick={() => downloadText('query-result.csv', toCSV(result.columns, result.rows.map((r) => r.map((v) => (v === null ? '' : String(v))))), 'text/csv')}>Download CSV</button>
                </div>
              )}
            </div>
            {err ? <ErrorBox err={err} sql={ran || sql} /> : result ? (result.rows.length ? <ResultTable result={result} caption="Query result" /> : <EmptyState title="No rows matched">The query ran, but nothing passed the filters.</EmptyState>) : <p className="muted small">Run a query to see results here.</p>}
          </section>
        </div>
        <aside className="card stack schema" aria-labelledby="sch-t">
          <h2 id="sch-t" className="h3">Schema</h2>
          <p className="small muted">Click a name to insert it.</p>
          {tables.length ? tables.map((t) => (
            <div key={t.name} className="schema-table">
              <button type="button" className="linkish tbl" onClick={() => insert(t.name)}>{t.name}</button> <span className="small muted">{t.rows.length} rows</span>
              <ul>{t.columns.map((c, i) => <li key={c}><button type="button" className="linkish" onClick={() => insert(c)}>{c}</button> <span className="type">{t.types[i] === 'number' ? '123' : 'abc'}</span></li>)}</ul>
            </div>
          )) : <EmptyState title="No tables" actions={<a className="btn btn-sm" href="#/tables">Load a CSV</a>}>Load a CSV to query it.</EmptyState>}
        </aside>
      </div>
    </div>
  );
}

/* ---------- Tables ---------- */
function TablesPage({ store, setStore, tables, setTables, storageWarn }: Ctx) {
  const [flash, setFlash] = useFlash();
  const [paste, setPaste] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [errors, setErrors] = useState<{ name?: string; csv?: string }>({});
  const [preview, setPreview] = useState<string | null>(tables[0]?.name ?? null);
  function addTable(name: string, text: string): string | null {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) return 'Use lowercase letters, numbers and underscores, starting with a letter.';
    let t: Table;
    try { t = tableFromCSV(name, text); } catch (e) { return e instanceof Error ? e.message : 'Couldn’t read that CSV.'; }
    if (t.rows.length > MAX_ROWS) return `That file has ${t.rows.length.toLocaleString()} rows — the limit is ${MAX_ROWS.toLocaleString()}.`;
    const exists = tables.some((x) => x.name === name);
    setTables(exists ? tables.map((x) => (x.name === name ? t : x)) : [...tables, t]);
    setPreview(name);
    setFlash({ kind: 'success', text: `${exists ? 'Replaced' : 'Loaded'} ${name}: ${t.rows.length} rows, ${t.columns.length} columns.` });
    return null;
  }
  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const f of [...files]) {
      if (!/\.(csv|tsv|txt)$/i.test(f.name)) { setFlash({ kind: 'error', text: `${f.name} isn’t a CSV file.` }); continue; }
      if (f.size > 5 * 1024 * 1024) { setFlash({ kind: 'error', text: `${f.name} is over 5 MB.` }); continue; }
      const err = addTable(tableName(f.name), await readFileText(f));
      if (err) setFlash({ kind: 'error', text: `${f.name}: ${err}` });
    }
  }
  function submitPaste(e: React.FormEvent) {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!pasteName.trim()) errs.name = 'Name the table.';
    if (!paste.trim()) errs.csv = 'Paste CSV with a header row.';
    if (!errs.name && !errs.csv) { const err = addTable(pasteName.trim().toLowerCase(), paste); if (err) (/name|letters/i.test(err) ? (errs.name = err) : (errs.csv = err)); }
    setErrors(errs);
    if (!Object.keys(errs).length) { setPaste(''); setPasteName(''); }
  }
  const shown = tables.find((t) => t.name === preview);
  return (
    <div className="stack">
      <PageHead eyebrow="Tables" title={<>Your <em>data.</em></>} description="Each CSV becomes a table. The first row is the header; columns with only numbers are treated as numbers." actions={store.demo ? <button type="button" className="btn btn-ghost" onClick={() => { setTables(tables.filter((t) => !['orders', 'customers', 'products'].includes(t.name))); setStore((s) => ({ ...s, demo: false })); setFlash({ kind: 'success', text: 'Demo tables removed.' }); }}>Remove demo tables</button> : <button type="button" className="btn btn-ghost" onClick={() => { const d = demoTables(); setTables([...tables.filter((t) => !d.some((x) => x.name === t.name)), ...d]); setStore((s) => ({ ...s, demo: true })); }}>Load demo tables</button>} />
      {storageWarn && <Notice kind="warn">Your tables are too large to keep in browser storage. They’ll work until you close this tab.</Notice>}
      {flash && <Notice kind={flash.kind} onDismiss={() => setFlash(null)}>{flash.text}</Notice>}
      <div className="grid-2">
        <div className="card stack">
          <h2 className="h3">Upload</h2>
          <p className="small muted">CSV or TSV, up to 5 MB and {MAX_ROWS.toLocaleString()} rows. The file name becomes the table name.</p>
          <label className="btn btn-primary file-btn">Choose CSV files<input type="file" accept=".csv,.tsv,.txt,text/csv" multiple className="sr-only" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} /></label>
        </div>
        <form className="card stack" onSubmit={submitPaste} noValidate>
          <h2 className="h3">Paste</h2>
          <Field label="Table name" error={errors.name}>{(p) => <input {...p} value={pasteName} onChange={(e) => setPasteName(e.target.value)} placeholder="e.g. sales" />}</Field>
          <Field label="CSV" error={errors.csv}>{(p) => <textarea {...p} className="code" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'region,total\nNorth,120'} />}</Field>
          <div><button type="submit" className="btn">Add table</button></div>
        </form>
      </div>
      {tables.length ? (
        <div className="stack">
          <div className="table-wrap card flush">
            <table className="table">
              <caption className="sr-only">Loaded tables</caption>
              <thead><tr><th scope="col">Table</th><th scope="col" className="num">Rows</th><th scope="col">Columns</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{tables.map((t) => (
                <tr key={t.name} className={preview === t.name ? 'is-sel' : ''}>
                  <th scope="row" className="mono">{t.name}{['orders', 'customers', 'products'].includes(t.name) && store.demo && <> <DemoTag /></>}</th>
                  <td className="num">{t.rows.length.toLocaleString()}</td>
                  <td className="small mono">{t.columns.join(', ')}</td>
                  <td className="nowrap"><button type="button" className="btn btn-sm btn-ghost" aria-pressed={preview === t.name} onClick={() => setPreview(t.name)}>Preview</button><button type="button" className="btn btn-sm btn-ghost" aria-label={`Remove ${t.name}`} onClick={() => { if (window.confirm(`Remove the ${t.name} table?`)) { setTables(tables.filter((x) => x.name !== t.name)); if (preview === t.name) setPreview(null); } }}>Remove</button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {shown && <section className="card stack" aria-labelledby="pv-t"><h2 id="pv-t" className="h3">{shown.name} — first 10 rows</h2><ResultTable result={{ columns: shown.columns.map((c, i) => `${c} (${shown.types[i] === 'number' ? 'number' : 'text'})`), rows: shown.rows.slice(0, 10), scanned: 0, ms: 0 }} caption={`Preview of ${shown.name}`} /></section>}
        </div>
      ) : <EmptyState title="No tables yet">Upload or paste a CSV to start querying.</EmptyState>}
    </div>
  );
}

/* ---------- Saved ---------- */
function SavedPage({ store, setStore }: Ctx) {
  const open = (sql: string) => { setStore((s) => ({ ...s, sql })); window.location.hash = '/query'; };
  return (
    <div className="stack">
      <PageHead eyebrow="Saved" title={<>Queries <em>worth keeping.</em></>} />
      <section className="card stack" aria-labelledby="sv-t">
        <h2 id="sv-t" className="h3">Saved queries</h2>
        {store.saved.length ? <ul className="query-list">{store.saved.map((q) => (
          <li key={q.id}>
            <div className="row-between"><strong>{q.name}</strong><span className="row-gap"><button type="button" className="btn btn-sm" onClick={() => open(q.sql)}>Open</button><button type="button" className="btn btn-sm btn-ghost" aria-label={`Delete ${q.name}`} onClick={() => setStore((s) => ({ ...s, saved: s.saved.filter((x) => x.id !== q.id) }))}>Delete</button></span></div>
            <pre className="code sql-snippet">{q.sql}</pre>
          </li>
        ))}</ul> : <EmptyState title="Nothing saved">Use “Save as” in the editor.</EmptyState>}
      </section>
      <section className="card stack" aria-labelledby="hi-t">
        <div className="row-between"><h2 id="hi-t" className="h3">Recent runs</h2>{store.history.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStore((s) => ({ ...s, history: [] }))}>Clear history</button>}</div>
        {store.history.length ? <ul className="query-list">{store.history.map((h, i) => (
          <li key={i}>
            <div className="row-between"><span className="small muted">{new Date(h.at).toLocaleString()} · {h.error ? <span className="err-text">Error</span> : `${h.rows} rows`}</span><button type="button" className="btn btn-sm btn-ghost" onClick={() => open(h.sql)}>Open</button></div>
            <pre className="code sql-snippet">{h.sql}</pre>
            {h.error && <p className="small err-text">{h.error}</p>}
          </li>
        ))}</ul> : <p className="small muted">Queries you run appear here (last 20).</p>}
      </section>
    </div>
  );
}
