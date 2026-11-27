/** Shared table renderer for private Slack Work Object panes. Data and actions come from authenticated routes. */
export function embeddedTablePage(nonce: string, apiPath: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mayassistant</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font: 14px/1.45 system-ui, sans-serif; }
    body { margin: 0; color: CanvasText; background: Canvas; }
    [hidden] { display: none !important; }
    main { padding: clamp(12px, 3vw, 24px); }
    h1 { font-size: 21px; margin: 0 0 16px; }
    .filters { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; margin-bottom: 14px; }
    label { display: grid; gap: 4px; font-weight: 600; }
    label:first-child { flex: 1; min-width: 130px; }
    input, select, button { box-sizing: border-box; min-height: 34px; font: inherit; color: inherit; background: Canvas; border: 1px solid color-mix(in srgb, CanvasText 28%, Canvas); border-radius: 5px; padding: 5px 8px; }
    button { cursor: pointer; font-weight: 600; }
    button:disabled { cursor: default; opacity: .6; }
    :focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
    .scroll { overflow-x: auto; border: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); border-radius: 7px; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    th, td { padding: 9px 8px; vertical-align: top; overflow-wrap: anywhere; white-space: pre-wrap; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, Canvas); }
    th { background: color-mix(in srgb, CanvasText 8%, Canvas); }
    tr:last-child td { border-bottom: 0; }
    td:last-child { width: 1%; white-space: nowrap; }
    #status { min-height: 1.45em; }
  </style>
</head>
<body>
  <main>
    <h1 id="title">Mayassistant</h1>
    <div class="filters" id="filters" hidden>
      <label>Rechercher<input type="search" id="search" autocomplete="off"></label>
      <label id="filter-label"><span id="filter-title"></span><select id="filter"><option value="">Tous</option></select></label>
    </div>
    <p id="status" role="status">Chargement du tableau…</p>
    <div class="scroll" id="results" hidden><table aria-labelledby="title"><thead></thead><tbody></tbody></table></div>
  </main>
  <script nonce="${nonce}">
    const base = ${JSON.stringify(apiPath)};
    const token = location.hash.slice(1);
    const status = document.getElementById('status');
    const search = document.getElementById('search');
    const filter = document.getElementById('filter');
    const tbody = document.querySelector('tbody');
    const activated = new Set();
    const headers = { Authorization: 'Bearer ' + token };
    const read = cell => Array.isArray(cell) ? cell.map(part => part.text).join('') : cell;

    async function open(index, button) {
      button.disabled = true;
      status.textContent = 'Ouverture dans la conversation…';
      try {
        const response = await fetch(base + '/ouvrir', { method: 'POST', credentials: 'omit',
          headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ row: index }) });
        if (!response.ok) throw new Error(String(response.status));
        activated.add(index);
        status.textContent = 'Écran demandé. Retrouvez-le dans votre conversation Slack.';
      } catch (error) {
        button.disabled = false;
        status.textContent = error.message === '401'
          ? 'Cette consultation a expiré. Rouvrez la carte dans Slack.'
          : 'Impossible d’ouvrir cette ligne. Réessayez.';
      }
    }

    function renderCell(cell) {
      const td = document.createElement('td');
      if (!Array.isArray(cell)) { td.textContent = cell; return td; }
      for (const part of cell) {
        let target;
        try { target = new URL(part.url); } catch { /* Plain text */ }
        if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
          td.append(document.createTextNode(part.text));
          continue;
        }
        const link = document.createElement('a');
        link.textContent = part.text;
        link.href = target.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        td.append(link);
      }
      return td;
    }

    async function start() {
      if (!token) { status.textContent = 'Ouvrez ce tableau depuis la carte dans votre conversation Slack.'; return; }
      const response = await fetch(base + '/donnees', { headers, credentials: 'omit' });
      if (!response.ok) throw new Error('Unavailable');
      const { title, columns, rows, filterColumn } = await response.json();
      document.title = title + ' · Mayassistant';
      document.getElementById('title').textContent = title;
      const headings = document.createElement('tr');
      for (const name of [...columns, 'Actions']) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = name;
        headings.append(th);
      }
      document.querySelector('thead').append(headings);
      if (filterColumn === undefined) document.getElementById('filter-label').hidden = true;
      else {
        document.getElementById('filter-title').textContent = columns[filterColumn];
        for (const value of new Set(rows.map(row => read(row[filterColumn])).filter(Boolean))) filter.add(new Option(value, value));
      }

      function render() {
        tbody.replaceChildren();
        const query = search.value.trim().toLocaleLowerCase('fr');
        rows.forEach((row, index) => {
          if (filter.value && read(row[filterColumn]) !== filter.value) return;
          if (!row.some(cell => read(cell).toLocaleLowerCase('fr').includes(query))) return;
          const tr = document.createElement('tr');
          tr.append(...row.map(renderCell));
          const actions = document.createElement('td');
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = 'Ouvrir';
          button.setAttribute('aria-label', 'Ouvrir ' + read(row[0]));
          button.disabled = activated.has(index);
          button.addEventListener('click', () => open(index, button));
          actions.append(button);
          tr.append(actions);
          tbody.append(tr);
        });
        status.textContent = tbody.rows.length ? '' : 'Aucun résultat.';
      }

      search.addEventListener('input', render);
      filter.addEventListener('change', render);
      document.getElementById('filters').hidden = false;
      document.getElementById('results').hidden = false;
      render();
    }

    start().catch(() => { status.textContent = 'Ce tableau est indisponible ou a expiré. Rouvrez la carte dans Slack.'; });
  </script>
</body>
</html>`;
}
